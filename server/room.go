package server

import (
	"encoding/json"
	"time"
)

type Room struct {
	code string
	name string

	// Identity
	hostToken string

	// Clients
	clients map[*Client]bool

	// Track disconnected players (nickname -> disconnected time)
	disconnectedPlayers map[string]time.Time

	// Connection channels
	register   chan *JoinRequest
	unregister chan *Client
	broadcast  chan Message

	// State
	hostConnected bool
	emptySince    time.Time
	gamePhase     string // Track current game phase (LOBBY, DRAWING, DRAWER_PREPARING, etc.)

	hub *Hub
}

type Message struct {
	Source *Client
	Data   []byte
}

func NewRoom(code, name, hostToken string, hub *Hub) *Room {
	return &Room{
		code:                code,
		name:                name,
		hostToken:           hostToken,
		clients:             make(map[*Client]bool),
		disconnectedPlayers: make(map[string]time.Time),
		register:            make(chan *JoinRequest),
		unregister:          make(chan *Client),
		broadcast:           make(chan Message),
		hub:                 hub,
		hostConnected:       false,
		emptySince:          time.Time{}, // Start with zero time - room is not empty until first client leaves
		gamePhase:           "LOBBY",     // Initialize with LOBBY phase
	}
}

func (r *Room) Run() {
	ticker := time.NewTicker(1 * time.Minute)
	defer func() {
		ticker.Stop()
		r.hub.CloseRoom(r.code)
	}()

	for {
		select {
		case req := <-r.register:
			client := req.Client
			isHost := req.HostToken != "" && req.HostToken == r.hostToken

			// Check if game is active - prevent new players from joining mid-game
			// Only allow joining if phase is LOBBY or GAME_OVER (not during DRAWER_PREPARING, DRAWING, etc.)
			isGameActive := r.gamePhase != "LOBBY" && r.gamePhase != "GAME_OVER"
			if isGameActive && !isHost {
				// Check if this is a reconnection (nickname exists in disconnected list)
				_, isReconnection := r.disconnectedPlayers[req.Nickname]
				if !isReconnection {
					// New player trying to join mid-game - reject
					r.sendError(client, "Game in progress - cannot join now")
					continue
				}
			}

			// Check nickname uniqueness
			// Check if nickname is already taken by a connected client
			nicknameTaken := false
			for c := range r.clients {
				if c.id == req.Nickname {
					nicknameTaken = true
					break
				}
			}

			if nicknameTaken && !isHost {
				// Nickname is taken by a connected player (host can always reconnect with token)
				r.sendError(client, "Nickname already taken")
				continue
			}

			// If host, they can always reconnect (even if someone else has their nickname)
			// For regular players, check if this is a reconnection
			wasDisconnected := false
			if !isHost {
				// Check if this is a reconnection (nickname was disconnected)
				// Remove from disconnected list if they're reconnecting
				_, wasDisconnected = r.disconnectedPlayers[req.Nickname]
				delete(r.disconnectedPlayers, req.Nickname)
			}

			// Reconnection logic:
			// If isHost, we update hostConnected status
			if isHost {
				r.hostConnected = true
				client.isHost = true
				// Notify everyone else that host is back
				r.broadcastParams("HOST_RECONNECTED", nil)
			} else {
				// If normal player joining
				// If game is paused (host disconnected), we should tell them?
				// They will receive initial state from Host anyway.
				// BUT if host is disconnected, they receive nothing.
				if !r.hostConnected {
					r.sendParams(client, "GAME_PAUSED", nil)
				}

				// Notify host that a player reconnected (so host can resend game state)
				if wasDisconnected {
					r.broadcastParams("PLAYER_RECONNECTED", map[string]interface{}{
						"nickname": req.Nickname,
					})
				}
			}

			r.clients[client] = true
			client.room = r
			client.id = req.Nickname // Simple nickname as ID for now

			// Collect player list for the newcomer
			playerList := []map[string]interface{}{}
			for c := range r.clients {
				playerList = append(playerList, map[string]interface{}{
					"nickname": c.id,
					"is_host":  c.isHost,
				})
			}

			// Notify success to newcomer with full player list
			resp := map[string]interface{}{
				"room_code": r.code,
				"is_host":   isHost,
				"nickname":  req.Nickname,
				"players":   playerList,
			}
			if isHost {
				resp["host_token"] = r.hostToken
			}
			r.sendParams(client, "JOIN_SUCCESS", resp)

			// Notify others about the new player
			r.broadcastParamsExcluding(client, "PLAYER_JOINED", map[string]interface{}{
				"nickname": req.Nickname,
				"is_host":  isHost,
			})

			r.emptySince = time.Time{} // Reset timer

		case client := <-r.unregister:
			if _, ok := r.clients[client]; ok {
				nickname := client.id

				// Check if this client already left via LEAVE_ROOM (room is nil)
				// If so, skip the unregister logic since they were already handled
				if client.room == nil {
					// Client was already removed via LEAVE_ROOM, just clean up
					continue
				}

				delete(r.clients, client)
				client.room = nil

				// Track ALL disconnected players (including host) for reconnection
				r.disconnectedPlayers[nickname] = time.Now()

				if client.isHost {
					r.hostConnected = false
					r.broadcastParams("HOST_DISCONNECTED", nil)
					// Don't close room immediately - wait for host to reconnect
					// Room will close via timeout if empty for too long
				} else {
					// Mark as disconnected (not removed) so they can reconnect
					r.broadcastParams("PLAYER_DISCONNECTED", map[string]interface{}{
						"nickname": nickname,
					})
				}

				if len(r.clients) == 0 {
					r.emptySince = time.Now()
				} else {
					r.emptySince = time.Time{}
				}
			}

		case msg := <-r.broadcast:
			// Relay logic
			// If source is Host, broadcast to all (except source usually, or include?)
			// If source is Player, send ONLY to Host (Host decides what to do)

			// EXCEPTION: Chat? Drawing?
			// Ideally, EVERYTHING goes to Host. Host sends state updates back.
			// BUT this adds detailed latency.
			// Optimization: If DRAW_STROKE, maybe broadcast directly if we trust clients?
			// The prompt says "it will not manage game state anymore".
			// So purely signaling.

			// 1. Parse Type
			var typeProbe struct {
				Type string `json:"type"`
			}
			json.Unmarshal(msg.Data, &typeProbe)

			if msg.Source.isHost {
				// Handle special messages from host
				if typeProbe.Type == "CLOSE_ROOM" {
					// Host is closing the room - notify everyone and shut down
					r.broadcastParams("ROOM_CLOSED", nil)
					return // This will trigger the deferred cleanup
				}

				// Track game phase changes to manage join restrictions
				if typeProbe.Type == "GAME_STATE_UPDATE" {
					var fullPayload struct {
						Type    string `json:"type"`
						Payload struct {
							GameState struct {
								Phase string `json:"phase"`
							} `json:"game_state"`
						} `json:"payload"`
					}
					json.Unmarshal(msg.Data, &fullPayload)

					// Update current game phase
					if fullPayload.Payload.GameState.Phase != "" {
						r.gamePhase = fullPayload.Payload.GameState.Phase
					}
				}

				// Host -> Everyone
				// Usually State Updates, Chat confirmations, etc.
				for client := range r.clients {
					// Don't echo back to host unless needed? Host usually updates own UI directly.
					if client != msg.Source {
						select {
						case client.send <- msg.Data:
						default:
							// Channel full or closed - skip
						}
					}
				}
			} else {
				// Handle player messages
				if typeProbe.Type == "LEAVE_ROOM" {
					// Player intentionally leaving - remove them
					nickname := msg.Source.id
					if _, ok := r.clients[msg.Source]; ok {
						// Send confirmation to leaving client first (before removing from map)
						r.sendParams(msg.Source, "LEFT_ROOM", nil)

						delete(r.clients, msg.Source)
						msg.Source.room = nil

						// Remove from disconnected list if they were there (intentional leave, not reconnecting)
						delete(r.disconnectedPlayers, nickname)

						// Broadcast to remaining clients (excluding the one that just left)
						r.broadcastParamsExcluding(msg.Source, "PLAYER_LEFT", map[string]interface{}{
							"nickname": nickname,
						})

						// Only mark room as empty if there are no clients left
						// If there are still clients (including host), reset the empty timer
						if len(r.clients) == 0 {
							r.emptySince = time.Now()
						} else {
							r.emptySince = time.Time{}
						}
					}
					continue // Go back to top of for loop, don't process further in this case
				}

				// Player -> Host
				// Only send to Host
				sent := false
				for client := range r.clients {
					if client.isHost {
						select {
						case client.send <- msg.Data:
							sent = true
						default:
							// Channel full or closed - skip
						}
						break
					}
				}

				// Special Case: Direct Echo for Latency?
				// If "DRAW_STROKE", maybe we echo to others immediately?
				// No, let's stick to strict architecture first. Player -> Host -> Players.
				// Host will receive stroke, validate, and broadcast "DRAW_STROKE".

				if !sent {
					// Host offline
					// Maybe queue? Or just drop.
				}
			}

		case <-ticker.C:
			// Cleanup if empty for too long
			if !r.emptySince.IsZero() && time.Since(r.emptySince) > 5*time.Minute {
				return // Closes room
			}

			// Clean up old disconnected players (older than 5 minutes)
			now := time.Now()
			for nickname, disconnectedTime := range r.disconnectedPlayers {
				if now.Sub(disconnectedTime) > 5*time.Minute {
					delete(r.disconnectedPlayers, nickname)
				}
			}
		}
	}
}

func (r *Room) broadcastParams(typeStr string, payload interface{}) {
	msg, _ := json.Marshal(map[string]interface{}{
		"type":    typeStr,
		"payload": payload,
	})
	for client := range r.clients {
		select {
		case client.send <- msg:
		default:
			// Don't remove client immediately - let unregister handle it
			// Just skip sending if channel is full to avoid blocking
		}
	}
}

func (r *Room) sendParams(c *Client, typeStr string, payload interface{}) {
	msg, _ := json.Marshal(map[string]interface{}{
		"type":    typeStr,
		"payload": payload,
	})
	select {
	case c.send <- msg:
	default:
		// Channel full or closed - skip sending
		// Don't remove client here, let unregister handle it
	}
}

func (r *Room) sendError(c *Client, msg string) {
	resp, _ := json.Marshal(map[string]interface{}{
		"type": "ERROR",
		"payload": map[string]string{
			"message": msg,
		},
	})
	select {
	case c.send <- resp:
	default:
		// Channel full or closed - skip
	}
}

func (r *Room) broadcastParamsExcluding(exclude *Client, typeStr string, payload interface{}) {
	msg, _ := json.Marshal(map[string]interface{}{
		"type":    typeStr,
		"payload": payload,
	})
	for client := range r.clients {
		if client == exclude {
			continue
		}
		select {
		case client.send <- msg:
		default:
			// Don't remove client immediately - let unregister handle it
			// Just skip sending if channel is full to avoid blocking
		}
	}
}
