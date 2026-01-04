from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
import logging
import json
import os

from models import CreateRoomRequest
from manager import manager

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
async def get():
    # Return index.html as a static file to avoid Jinja2 template parsing of Vue.js delimiters
    return FileResponse("static/index.html")

@app.post("/api/rooms")
async def create_room(request: CreateRoomRequest):
    config_dict = request.config.dict() if request.config else None
    room_id = manager.create_room(request.name, request.password, request.game_type, config_dict)
    return {"room_id": room_id, "message": "Room created"}

@app.get("/api/rooms")
async def list_rooms():
    public_rooms = []
    for r_id, r_data in manager.rooms.items():
        public_rooms.append({
            "id": r_data["id"],
            "name": r_data["name"],
            "has_password": bool(r_data["password"]),
            "players_count": sum(1 for p in r_data["players"].values() if p["connected"])
        })
    return public_rooms

@app.websocket("/ws/{room_id}/{client_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str, client_id: str):
    room = manager.get_room(room_id)
    if not room:
        await websocket.close(code=4000)
        return

    await manager.connect(websocket, room_id, client_id)
    
    current_nickname = None

    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
                msg_type = msg.get("type")
                
                if msg_type == "JOIN":
                    nickname = msg.get("payload", {}).get("nickname", "Anonymous")
                    result = manager.try_join_room(room_id, client_id, nickname)
                    
                    if result == "OK":
                        current_nickname = nickname
                        
                        # Send Success to self
                        player_list = []
                        for n, p in room["players"].items():
                            if p["connected"]:
                                player_list.append({
                                    "nickname": n,
                                    "is_host": p["is_host"],
                                    "is_ready": p.get("is_ready", False),
                                    "color": p.get("color", "#FFFFFF")
                                })
                        
                        await manager.send_to_client(room_id, client_id, {
                            "type": "JOIN_SUCCESS",
                            "payload": {
                                "room_id": room_id,
                                "players": player_list,
                                "state": room["state"],
                                "game_type": room["game_type"],
                                "config": room["config"]
                            }
                        })

                        # Broadcast to room
                        await manager.broadcast(room_id, {
                            "type": "PLAYER_JOINED",
                            "payload": {
                                "nickname": nickname,
                                "is_ready": False,
                                "color": room["players"][nickname].get("color", "#FFFFFF"),
                                "total_players": len(player_list)
                            }
                        })

                        # Sync state for the newly joined/reconnected player
                        if room.get("state") == "playing":
                            await manager.send_full_state_to_client(room_id, client_id, nickname)
                    elif result == "TAKEN":
                        await manager.send_to_client(room_id, client_id, {
                            "type": "ERROR",
                            "payload": {"message": "Nickname is already taken in this room."}
                        })
                
                elif msg_type == "TOGGLE_READY":
                     if current_nickname:
                         is_ready = msg.get("payload", {}).get("is_ready", False)
                         manager.set_player_ready(room_id, current_nickname, is_ready)
                         await manager.broadcast(room_id, {
                             "type": "PLAYER_UPDATE",
                             "payload": {
                                 "nickname": current_nickname,
                                 "is_ready": is_ready
                             }
                         })
                
                elif msg_type == "UPDATE_CONFIG":
                    if current_nickname and room["players"][current_nickname]["is_host"]:
                        new_config = msg.get("payload", {}).get("config", {})
                        manager.update_game_config(room_id, new_config)
                        await manager.broadcast(room_id, {
                            "type": "CONFIG_UPDATE",
                            "payload": {
                                "config": room["config"]
                            }
                        })

                elif msg_type == "START_GAME":
                     # Verify host
                     if current_nickname and room["players"][current_nickname]["is_host"]:
                         if manager.can_start_game(room_id):
                             await manager.start_game(room_id) # Now async
                             # GAME_STARTED broadcast is inside start_game -> broadcast_game_state
                         else:
                              await manager.send_to_client(room_id, client_id, {
                                "type": "ERROR",
                                "payload": {"message": "Cannot start game. Need 2+ players and all ready."}
                            })

                elif msg_type == "CHAT":
                     if current_nickname:
                         await manager.process_chat_message(room_id, current_nickname, msg.get("payload", {}).get("text"))

                elif msg_type == "DRAW_STROKE":
                    if current_nickname:
                        await manager.record_stroke(room_id, current_nickname, msg.get("payload"))
                        await manager.broadcast(room_id, {
                            "type": "DRAW_STROKE",
                            "payload": msg.get("payload")
                        }, exclude_client=client_id)
                
                elif msg_type == "UNDO_STROKE":
                    if current_nickname:
                        await manager.undo_stroke(room_id, current_nickname)

                elif msg_type == "START_ROUND":
                    if current_nickname:
                        await manager.start_active_round(room_id)

                elif msg_type == "CLEAR_CANVAS":
                    if current_nickname:
                        await manager.clear_canvas_history(room_id, current_nickname)
                
            except json.JSONDecodeError:
                pass
                
    except WebSocketDisconnect:
        manager.disconnect(room_id, client_id)
        # If user disconnected, we notify others but don't delete them from data immediately (to allow reconnect)
        if current_nickname and room_id in manager.rooms:
             # Check if player is still marked as disconnected in manager 
             # (manager.disconnect sets it to False)
             # We broadcast that they left/disconnected
             await manager.broadcast(room_id, {
                "type": "PLAYER_DISCONNECTED",
                "payload": {
                    "nickname": current_nickname
                }
            })
        logger.info(f"Client {client_id} disconnected")
