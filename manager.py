from fastapi import WebSocket
from typing import List, Dict, Optional
import uuid
import json
import asyncio
import time
import hashlib
import secrets

class ConnectionManager:
    def __init__(self):
        # active_connections: room_id -> {client_id -> WebSocket}
        self.active_connections: Dict[str, Dict[str, WebSocket]] = {}
        
        # rooms: room_id -> Room Data
        self.rooms: Dict[str, dict] = {}

    async def connect(self, websocket: WebSocket, room_id: str, client_id: str):
        await websocket.accept()
        if room_id not in self.active_connections:
            self.active_connections[room_id] = {}
        self.active_connections[room_id][client_id] = websocket
        
        # Room is not empty anymore
        if room_id in self.rooms:
            self.rooms[room_id]["empty_since"] = None

    def disconnect(self, room_id: str, client_id: str):
        if room_id in self.active_connections:
            if client_id in self.active_connections[room_id]:
                del self.active_connections[room_id][client_id]
            
            # Update player status to disconnected
            if room_id in self.rooms:
                room = self.rooms[room_id]
                for nickname, p_data in room["players"].items():
                    if p_data["client_id"] == client_id:
                        p_data["connected"] = False
                        break
                
                # Check if room is empty
                if not self.active_connections.get(room_id):
                    room["empty_since"] = time.time()
    
    async def broadcast(self, room_id: str, message: dict, exclude_client: str = None):
        if room_id in self.active_connections:
            broken_clients = []
            for client_id, connection in self.active_connections[room_id].items():
                if client_id == exclude_client:
                    continue
                try:
                    await connection.send_text(json.dumps(message))
                except Exception:
                    broken_clients.append(client_id)
            
            for client_id in broken_clients:
                self.disconnect(room_id, client_id)

    async def send_to_client(self, room_id: str, client_id: str, message: dict):
        if room_id in self.active_connections and client_id in self.active_connections[room_id]:
            try:
                await self.active_connections[room_id][client_id].send_text(json.dumps(message))
            except Exception:
                self.disconnect(room_id, client_id)

    def create_room(self, room_name: str, password: Optional[str] = None, game_type: str = "drawing", config: dict = None) -> str:
        # Enforce unique room names
        for r in self.rooms.values():
            if r["name"].lower() == room_name.lower():
                raise ValueError(f"Room name '{room_name}' is already taken.")
                
        room_id = str(uuid.uuid4())[:8]
        
        # Default config if not provided
        if config is None:
            from constants import WORD_SETS
            default_lang = next(iter(WORD_SETS.keys()))
            default_diff = next(iter(WORD_SETS[default_lang].keys()))
            config = {
                "round_duration": 60,
                "points_to_win": 50,
                "base_points": 10,
                "turn_order": "sequence",
                "host_plays": True,
                "word_language": default_lang,
                "word_difficulty": default_diff
            }

        hashed_password = None
        if password:
            hashed_password = hashlib.sha256(password.encode()).hexdigest()

        self.rooms[room_id] = {
            "id": room_id,
            "name": room_name,
            "password": hashed_password,
            "room_token": secrets.token_urlsafe(16),
            "game_type": game_type,
            "config": config,
            "players": {}, # nickname -> { client_id, is_host, connected }
            "state": "lobby",
            "empty_since": time.time() # Created empty, waiting for host to connect
        }
        return room_id
    
    def update_game_config(self, room_id: str, config: dict):
        if room_id in self.rooms:
            # Merge updates
            self.rooms[room_id]["config"].update(config)

    def get_room(self, room_id: str):
        return self.rooms.get(room_id)

    def get_word_set_metadata(self) -> dict:
        from constants import WORD_SETS, LANGUAGE_METADATA
        metadata = {"languages": {}, "difficulties": {}}
        for lang, diffs in WORD_SETS.items():
            metadata["languages"][lang] = LANGUAGE_METADATA.get(lang, lang)
            metadata["difficulties"][lang] = list(diffs.keys())
        return metadata
    
    def try_join_room(self, room_id: str, client_id: str, nickname: str, password: Optional[str] = None, token: Optional[str] = None) -> str:
        """
        Returns "OK" if joined/reconnected.
        Returns "TAKEN" if nickname is taken by a connected player.
        Returns "WRONG_PASSWORD" if password does not match.
        """
        if room_id not in self.rooms:
             return "ERROR"
        
        room = self.rooms[room_id]
        
        # Check Password (if not re-connecting)
        # We only check password for NEW joins or explicit validation?
        # Actually, for reconnecting users, do we need password?
        # If I am reconnecting, I probably should pass it or satisfy it, 
        # but usually reconnect happens auto. If room has password, we must check it.
        # But wait, if I am already in 'players' list, maybe I skip password check?
        # Let's say yes, if you are established player, you can reconnect.
        # BUT what if someone steals nickname?
        # For simplicity, ALWAYS check password if room has it.
        
        requires_password = room["password"] is not None
        if requires_password:
             # If valid token provided, skip password check
             if token and token == room.get("room_token"):
                 pass # Token auth success
             else:
                 if not password:
                     # It might be a reconnect where client didn't send password?
                     # But our client will send it if we implement it right.
                     # If nickname is in players...
                     pass # We'll enforce it.
                 
                 hashed_input = hashlib.sha256(password.encode()).hexdigest() if password else ""
                 if room["password"] != hashed_input:
                     # Exception: If I am already in players list? 
                     # Maybe we allow reconnects without password if we assume session persistence?
                     # The prompt says "joining room with password", implying initial join.
                     # Let's check logic:
                     if nickname in room["players"]:
                          # If trying to steal valid player, you need password too?
                          # Yes.
                          return "WRONG_PASSWORD"
                     
                     return "WRONG_PASSWORD"

        if nickname in room["players"]:
            existing = room["players"][nickname]
            if existing["connected"]:
                return "TAKEN"
                
            # Reconnection: Update client_id to the new connection
            # If we reached here, password was correct or not required
            existing["client_id"] = client_id
            existing["connected"] = True
            return "OK"
        else:
            # New join - only allowed in lobby
            if room["state"] != "lobby":
                return "GAME_STARTED"
                
            is_first = len(room["players"]) == 0
            
            from constants import COLORS
            import random
            
            # Find used colors
            used_colors = {p.get("color") for p in room["players"].values() if p.get("color")}
            available_colors = [c for c in COLORS if c not in used_colors]
            
            if available_colors:
                color = random.choice(available_colors)
            else:
                color = random.choice(COLORS) # Fallback if all taken
            
            import time
            room["empty_since"] = None # Ensure it is not marked empty

            room["players"][nickname] = {
                "client_id": client_id, 
                "is_host": is_first, 
                "connected": True,
                "is_ready": False,
                "score": 0,
                "color": color
            }
            return "OK"

    def set_player_ready(self, room_id: str, nickname: str, is_ready: bool):
        if room_id in self.rooms and nickname in self.rooms[room_id]["players"]:
            self.rooms[room_id]["players"][nickname]["is_ready"] = is_ready

    def can_start_game(self, room_id: str) -> bool:
        room = self.rooms.get(room_id)
        if not room: return False
        
        connected_players = [p for p in room["players"].values() if p["connected"]]
        
        # Determine playing players
        playing_count = 0
        all_ready = True
        
        host_plays = room["config"].get("host_plays", True)
        
        for p in connected_players:
            if p["is_host"] and not host_plays:
                continue # Host is spectating
            playing_count += 1
            if not p["is_ready"]:
                all_ready = False
        
        if playing_count < 2:
            return False
            
        return all_ready

    async def start_game(self, room_id: str):
        if room_id in self.rooms:
            room = self.rooms[room_id]
            room["state"] = "playing"
            
            # Initialize Game State
            room["game_state"] = {
                "round": 0,
                "drawer": None,
                "word": None,
                "turn_queue": [],
                "timer_end": 0,
                "phase": "PRE_ROUND",
                "current_word_obfuscated": "",
                "correct_guessers": [],
                "first_guess_time_left": 0,
                "first_guesser_nickname": None,
                "last_drawer": None,
                "last_word": None,
                "turn_results": {}, # nickname -> {points, time}
                "stroke_history": []
            }
            
            # Reset scores
            for p in room["players"].values():
                p["score"] = 0

            # Start first round
            await self.next_turn(room_id)

    def _get_turn_queue(self, room):
        # Filter players based on host_plays
        candidates = []
        host_plays = room["config"].get("host_plays", True)
        
        for n, p in room["players"].items():
            if not p["connected"]: continue
            if p["is_host"] and not host_plays: continue
            candidates.append(n)
            
        import random
        random.shuffle(candidates)
        return candidates
    async def next_turn(self, room_id: str):
        room = self.rooms[room_id]
        gs = room["game_state"]

        # Win Condition Check (End of any round)
        if gs["round"] > 0:
            max_score_threshold = room["config"]["points_to_win"]
            # Check if any player reached the threshold
            eligible_winners = [p for p in room["players"].values() if p["score"] >= max_score_threshold]
            
            if eligible_winners:
                # If multiple people crossed it, the one with the highest score wins.
                # If tied, we can just end it (the UI will show the list/leaderboard).
                await self.end_game(room_id)
                return

        # Check Turn Queue
        if not gs["turn_queue"]:
            gs["turn_queue"] = self._get_turn_queue(room)
            gs["round"] += 1

        if not gs["turn_queue"]:
             await self.end_game(room_id)
             return

        drawer = gs["turn_queue"].pop(0)
        gs["drawer"] = drawer
        
        # Select Word
        from constants import WORD_SETS
        import random
        
        default_lang = next(iter(WORD_SETS.keys()))
        language = room["config"].get("word_language", default_lang)
        difficulty = room["config"].get("word_difficulty") # Will fallback below
        
        # Fallback logic for language
        lang_set = WORD_SETS.get(language, WORD_SETS[default_lang])
        # Fallback logic for difficulty
        if not difficulty or difficulty not in lang_set:
            difficulty = next(iter(lang_set.keys()))
            
        all_words = lang_set[difficulty]
        
        word = random.choice(all_words)
        gs["word"] = word
        # For hints, we use underscores for letters and space for spaces. 
        # Frontend will handle the rendering.
        gs["current_word_obfuscated"] = "".join(["_" if c != " " else " " for c in word])
        
        # Transition to PREPARING (Manual Start)
        gs["phase"] = "DRAWER_PREPARING"
        gs["timer_end"] = 0 
        gs["correct_guessers"] = []
        gs["first_guess_time_left"] = 0
        gs["stroke_history"] = []
        
        await self.broadcast_game_state(room_id)

    async def start_active_round(self, room_id: str):
        room = self.rooms[room_id]
        gs = room["game_state"]
        if gs["phase"] != "DRAWER_PREPARING": return

        import time
        duration = room["config"]["round_duration"]
        gs["timer_end"] = time.time() + duration
        gs["phase"] = "DRAWING"
        gs["turn_results"] = {} # Clear old results now that new one starts
        
        await self.broadcast_game_state(room_id)
        asyncio.create_task(self._round_timer(room_id, duration, gs["drawer"], gs["word"]))

    async def _round_timer(self, room_id, duration, drawer, word):
        await asyncio.sleep(duration)
        room = self.rooms.get(room_id)
        if room:
            gs = room.get("game_state")
            if gs and gs["drawer"] == drawer and gs["word"] == word and gs["phase"] == "DRAWING":
                await self.end_round(room_id)

    async def end_round(self, room_id: str):
        room = self.rooms[room_id]
        gs = room["game_state"]
        # Allow ending from drawing or preparing if needed, but mostly drawing
        if gs["phase"] not in ["DRAWING", "DRAWER_PREPARING"]: return
        
        gs["last_drawer"] = gs["drawer"]
        gs["last_word"] = gs["word"]
        gs["timer_end"] = 0 # STOP the countdown

        # Apply points officially
        for nick, res in gs.get("turn_results", {}).items():
            if nick in room["players"]:
                room["players"][nick]["score"] += res["points"]

        # Jump straight to next turn / preparing
        await self.next_turn(room_id)

    async def end_game(self, room_id: str):
        room = self.rooms[room_id]
        room["game_state"]["phase"] = "GAME_OVER"
        await self.broadcast_game_state(room_id)

    async def broadcast_game_state(self, room_id: str):
         room = self.rooms[room_id]
         gs = room["game_state"]
         import time
         
         public_gs = {
             "round": gs.get("round", 1),
             "drawer": gs["drawer"],
             "phase": gs["phase"],
             "timer_end": gs["timer_end"],
             "time_left": max(0, gs["timer_end"] - time.time()) if gs["timer_end"] > 0 else 0,
             "word": gs["word"] if gs["phase"] in ["DRAWER_PREPARING", "GAME_OVER"] else None,
             "word_hints": gs["current_word_obfuscated"],
             "correct_guessers": gs.get("correct_guessers", []),
             "last_drawer": gs.get("last_drawer"),
             "last_word": gs.get("last_word"),
             "first_guesser_nickname": gs.get("first_guesser_nickname")
         }
         
         for nickname, p in room["players"].items():
              if p["connected"]:
                  is_drawer = (nickname == gs["drawer"])
                  view_gs = public_gs.copy()
                  # Drawer sees word in PREPARING and DRAWING
                  if is_drawer and gs["phase"] in ["DRAWING", "DRAWER_PREPARING"]:
                      view_gs["word"] = gs["word"]
                      
                  await self.send_to_client(room_id, p["client_id"], {
                      "type": "GAME_STATE_UPDATE",
                      "payload": {
                          "game_state": view_gs,
                          "scores": {n: pl["score"] for n, pl in room["players"].items()},
                          "turn_results": gs.get("turn_results", {})
                      }
                  })

    async def send_full_state_to_client(self, room_id: str, client_id: str, nickname: str):
        """Sends both GAME_STATE_UPDATE and STROKE_HISTORY_UPDATE to a single client."""
        room = self.rooms.get(room_id)
        if not room: return
        gs = room.get("game_state")
        if not gs: return

        import time
        public_gs = {
            "round": gs.get("round", 1),
            "drawer": gs["drawer"],
            "phase": gs["phase"],
            "timer_end": gs["timer_end"],
            "time_left": max(0, gs["timer_end"] - time.time()) if gs["timer_end"] > 0 else 0,
            "word": gs["word"] if gs["phase"] in ["DRAWER_PREPARING", "GAME_OVER"] else None,
            "word_hints": gs["current_word_obfuscated"],
            "correct_guessers": gs.get("correct_guessers", []),
            "last_drawer": gs.get("last_drawer"),
            "last_word": gs.get("last_word"),
            "first_guesser_nickname": gs.get("first_guesser_nickname")
        }

        is_drawer = (nickname == gs["drawer"])
        view_gs = public_gs.copy()
        if is_drawer and gs["phase"] in ["DRAWING", "DRAWER_PREPARING"]:
            view_gs["word"] = gs["word"]

        # 1. Send State
        await self.send_to_client(room_id, client_id, {
            "type": "GAME_STATE_UPDATE",
            "payload": {
                "game_state": view_gs,
                "scores": {n: pl["score"] for n, pl in room["players"].items()},
                "turn_results": gs.get("turn_results", {})
            }
        })

        # 2. Send History
        if "stroke_history" in gs:
            await self.send_to_client(room_id, client_id, {
                "type": "STROKE_HISTORY_UPDATE",
                "payload": {"history": gs["stroke_history"]}
            })

    async def process_chat_message(self, room_id: str, nickname: str, text: str):
        room = self.rooms[room_id]
        gs = room.get("game_state")
        is_playing = room["state"] == "playing" and gs and gs["phase"] == "DRAWING"
        
        if is_playing:
             if nickname == gs["drawer"]: return
             if nickname in gs["correct_guessers"]: return
             
             if text.lower().strip() == gs["word"].lower().strip():
                 # Correct Guess
                 import time
                 t_left = max(0, gs["timer_end"] - time.time())
                 base_points = room["config"].get("base_points", 10)
                 
                 is_first = len(gs["correct_guessers"]) == 0
                 duration = room["config"]["round_duration"]
                 time_taken = round(duration - t_left, 1)

                 if is_first:
                     gs["first_guess_time_left"] = t_left
                     gs["first_guesser_nickname"] = nickname
                     points = base_points
                     # Drawer points (calculated only on first guess)
                     drawer_points = min(base_points, round(t_left / (duration * 0.75) * base_points))
                     gs["turn_results"][gs["drawer"]] = {"points": drawer_points, "time": time_taken}
                 else:
                     t_first = gs["first_guess_time_left"]
                     if t_first > 0:
                         points = round((t_left / t_first) * base_points)
                     else:
                         points = 0 # Should not happen if guess is during active round
                 
                 gs["turn_results"][nickname] = {"points": points, "time": time_taken}
                 gs["correct_guessers"].append(nickname)
                 
                 await self.broadcast(room_id, {
                     "type": "CHAT",
                     "payload": { "sender": "System", "text": f"{nickname} guessed correctly!", "color": "#10B981" }
                 })
                 
                 # Check if all players guessed
                 guessers_needed = 0
                 host_plays = room["config"].get("host_plays", True)
                 for p_nick, p_data in room["players"].items():
                     if not p_data["connected"]: continue
                     if p_nick == gs["drawer"]: continue
                     if p_data["is_host"] and not host_plays: continue
                     guessers_needed += 1
                 
                 if len(gs["correct_guessers"]) >= guessers_needed:
                     await self.end_round(room_id)
                 else:
                     # Update game state to show who guessed? Or just scores.
                     await self.broadcast_game_state(room_id)
                 return
             else:
                 # Incorrect - Masked
                 color = room["players"][nickname].get("color", "#FFFFFF")
                 await self.broadcast(room_id, {
                     "type": "CHAT",
                     "payload": { "sender": nickname, "color": color, "text": "guessed incorrectly" }
                 })
                 return
        
        # Normal chat (Lobby, Pre/Post round)
        color = room["players"][nickname].get("color", "#FFFFFF")
        await self.broadcast(room_id, {
            "type": "CHAT",
            "payload": { "sender": nickname, "color": color, "text": text }
        })

    def remove_player_from_room(self, room_id: str, nickname: str):
         if room_id in self.rooms and nickname in self.rooms[room_id]["players"]:
             del self.rooms[room_id]["players"][nickname]

    def is_drawer(self, room_id: str, nickname: str) -> bool:
        if room_id not in self.rooms: return False
        return self.rooms[room_id]["game_state"]["drawer"] == nickname

    async def record_stroke(self, room_id: str, nickname: str, stroke: dict):
        if not self.is_drawer(room_id, nickname): return
        gs = self.rooms[room_id]["game_state"]
        if gs["phase"] not in ["DRAWING", "DRAWER_PREPARING"]: return
        gs["stroke_history"].append(stroke)

    async def undo_stroke(self, room_id: str, nickname: str):
        if not self.is_drawer(room_id, nickname): return
        gs = self.rooms[room_id]["game_state"]
        if gs["phase"] not in ["DRAWING", "DRAWER_PREPARING"]: return
        if gs["stroke_history"]:
            last_stroke = gs["stroke_history"][-1]
            action_id = last_stroke.get("actionId")
            
            if action_id:
                # Remove all strokes with the same actionId
                gs["stroke_history"] = [s for s in gs["stroke_history"] if s.get("actionId") != action_id]
            else:
                # Fallback for old/legacy strokes
                gs["stroke_history"].pop()

            # Broadcast the full history update
            await self.broadcast(room_id, {
                "type": "STROKE_HISTORY_UPDATE",
                "payload": {"history": gs["stroke_history"]}
            })

    async def clear_canvas_history(self, room_id: str, nickname: str):
        if not self.is_drawer(room_id, nickname): return
        gs = self.rooms[room_id]["game_state"]
        gs["stroke_history"] = []
        await self.broadcast(room_id, {
            "type": "CLEAR_CANVAS",
            "payload": {}
        })

    async def close_room(self, room_id: str):
        if room_id in self.rooms:
            # Notify everyone
            await self.broadcast(room_id, {
                "type": "ROOM_CLOSED",
                "payload": {}
            })
            # Close all connections
            if room_id in self.active_connections:
                for client_id, ws in list(self.active_connections[room_id].items()):
                    await ws.close()
                del self.active_connections[room_id]
            
            # Remove room data
            del self.rooms[room_id]

    def cleanup_empty_rooms(self):
        import time
        now = time.time()
        to_remove = []
        for room_id, room in self.rooms.items():
            if room.get("empty_since") and (now - room["empty_since"] > 300): # 5 minutes
                to_remove.append(room_id)
        
        for room_id in to_remove:
            # Just delete it, no one is there to notify
            if room_id in self.active_connections:
                del self.active_connections[room_id]
            del self.rooms[room_id]

# Global instance
manager = ConnectionManager()
