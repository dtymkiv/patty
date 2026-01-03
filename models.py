from pydantic import BaseModel
from typing import Optional

from enum import Enum

class GameType(str, Enum):
    DRAWING = "drawing"

class GameConfig(BaseModel):
    round_duration: int = 60
    points_to_win: int = 5
    turn_order: str = "sequence" # "sequence" or "winner"
    host_plays: bool = True

class CreateRoomRequest(BaseModel):
    name: str
    password: Optional[str] = None
    game_type: GameType = GameType.DRAWING
    config: Optional[GameConfig] = None

class JoinRoomRequest(BaseModel):
    room_id: str
    password: Optional[str] = None
    nickname: str

class Player(BaseModel):
    nickname: str
    client_id: str
    is_host: bool = False
