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

@app.on_event("startup")
async def startup_event():
    import asyncio
    async def cleanup_loop():
        while True:
            await asyncio.sleep(60) # Every minute
            manager.cleanup_empty_rooms()
    asyncio.create_task(cleanup_loop())

@app.get("/")
async def get():
    # Return index.html as a static file to avoid Jinja2 template parsing of Vue.js delimiters
    return FileResponse("static/index.html")

@app.get("/rooms/{room_id}")
async def get_room(room_id: str):
    # Serve the same index.html for room routes (SPA fallback)
    return FileResponse("static/index.html")

@app.post("/api/rooms")
async def create_room(request: CreateRoomRequest):
    config_dict = request.config.dict() if request.config else None
    try:
        room_id = manager.create_room(request.name, request.password, request.game_type, config_dict)
        return {"room_id": room_id, "message": "Room created"}
    except ValueError as e:
        return JSONResponse(status_code=400, content={"message": str(e)})

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

@app.get("/api/word-sets/metadata")
async def get_word_set_metadata():
    return manager.get_word_set_metadata()

@app.websocket("/ws/{room_id}/{client_id}")
async def websocket_endpoint(websocket: WebSocket, room_id: str, client_id: str):
    room = manager.get_room(room_id)
    if not room:
        await websocket.accept()
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
                    password = msg.get("payload", {}).get("password")
                    token = msg.get("payload", {}).get("token")
                    result = manager.try_join_room(room_id, client_id, nickname, password, token)
                    
                    if result == "OK":
                        current_nickname = nickname
                        
                        # Send Success to self
                        player_list = []
                        for n, p in room["players"].items():
                            player_list.append({
                                "nickname": n,
                                "is_host": p["is_host"],
                                "is_ready": p.get("is_ready", False),
                                "color": p.get("color", "#FFFFFF"),
                                "connected": p.get("connected", True),
                                "score": p.get("score", 0)
                            })
                        
                        await manager.send_to_client(room_id, client_id, {
                            "type": "JOIN_SUCCESS",
                            "payload": {
                                "room_id": room_id,
                                "players": player_list,
                                "state": room["state"],
                                "game_type": room["game_type"],
                                "config": room["config"],
                                "room_token": room.get("room_token")
                            }
                        })

                        # Broadcast to room
                        await manager.broadcast(room_id, {
                            "type": "PLAYER_JOINED",
                            "payload": {
                                "nickname": nickname,
                                "is_ready": False,
                                "color": room["players"][nickname].get("color", "#FFFFFF"),
                                "connected": room["players"][nickname].get("connected", True),
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
                    elif result == "GAME_STARTED":
                         await manager.send_to_client(room_id, client_id, {
                            "type": "ERROR",
                            "payload": {"message": "Game has already started in this room. You can only join if you were already playing."}
                        })
                    elif result == "WRONG_PASSWORD":
                         await manager.send_to_client(room_id, client_id, {
                            "type": "ERROR",
                            "payload": {"message": "Incorrect password"}
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

                elif msg_type == "LEAVE_ROOM":
                    # Explicit leave
                    if current_nickname:
                        # If host, close room
                        if room["players"][current_nickname]["is_host"]:
                            await manager.close_room(room_id)
                            # Close logic closes sockets, so loop will break or we should break here? 
                            # Connection closed exception will be raised or we break.
                            break
                        else:
                            # Just remove player? Or let them disconnect normally?
                            # Standard leave behavior is just disconnect usually, but we want to free the nickname perhaps?
                            # For now, let's treat it as a disconnect but maybe explicit remove from players dict?
                            # If we remove strictly, reconnect won't work. 
                            # If they explicitly clicked "Leave", they probably don't want to reconnect to the same state.
                            # So removing is correct.
                            await manager.broadcast(room_id, {
                                "type": "PLAYER_LEFT",
                                "payload": {"nickname": current_nickname}
                            })
                            manager.remove_player_from_room(room_id, current_nickname)
                            # Close socket
                            await websocket.close()
                            # Break loop
                            break
                
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
