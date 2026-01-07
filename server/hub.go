package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	mathrand "math/rand"
	"net/http"
	"sync"
	"time"
)

type Hub struct {
	// Registered rooms.
	rooms map[string]*Room
	mu    sync.RWMutex

	// Code generation: counter and secret for hash-based generation
	codeCounter   int64
	codeSecret    []byte
	codeCounterMu sync.Mutex

	// Register requests from the clients.
	register chan *Client

	// Unregister requests from clients.
	unregister chan *Client

	// Join requests
	joinRoom chan *JoinRequest
}

type JoinRequest struct {
	Client    *Client
	RoomCode  string
	Nickname  string
	HostToken string
}

func NewHub() *Hub {
	mathrand.Seed(time.Now().UnixNano())
	// Generate a random secret for hash-based code generation
	secret := make([]byte, 32)
	rand.Read(secret)

	return &Hub{
		register:    make(chan *Client),
		unregister:  make(chan *Client),
		rooms:       make(map[string]*Room),
		joinRoom:    make(chan *JoinRequest),
		codeCounter: mathrand.Int63n(1000000), // Random starting point
		codeSecret:  secret,
	}
}

func (h *Hub) Run() {
	for {
		select {
		case <-h.register:
			// Just registered, waiting for JOIN command
		case client := <-h.unregister:
			if client.room != nil {
				// Non-blocking send to room's unregister channel
				// If room is closing/closed, this won't block the hub
				select {
				case client.room.unregister <- client:
				default:
					// Room is closing, client already removed
				}
			}
		case req := <-h.joinRoom:
			h.handleJoin(req)
		}
	}
}

func (h *Hub) handleJoin(req *JoinRequest) {
	h.mu.RLock()
	room, ok := h.rooms[req.RoomCode]
	h.mu.RUnlock()

	if !ok {
		h.sendError(req.Client, "Room not found")
		return
	}

	room.register <- req
}

func (h *Hub) CreateRoom(name string) (*Room, string) {
	code := h.generateCode()
	hostToken := h.generateToken()

	room := NewRoom(code, name, hostToken, h)

	h.mu.Lock()
	h.rooms[code] = room
	h.mu.Unlock()

	go room.Run()

	return room, hostToken
}

func (h *Hub) generateCode() string {
	// Generate random-looking codes using hash of counter + secret
	// This produces non-sequential, random-appearing codes while tracking used ones
	h.codeCounterMu.Lock()
	defer h.codeCounterMu.Unlock()

	maxAttempts := 1000 // Reasonable limit
	for i := 0; i < maxAttempts; i++ {
		// Hash counter + secret to get random-looking number
		hash := sha256.Sum256(append(h.codeSecret, []byte(fmt.Sprintf("%d", h.codeCounter))...))
		// Use first 3 bytes to generate 6-digit code
		codeNum := int(hash[0])<<16 | int(hash[1])<<8 | int(hash[2])
		codeNum = codeNum % 1000000
		code := fmt.Sprintf("%06d", codeNum)

		// Check if code is already in use
		h.mu.RLock()
		_, exists := h.rooms[code]
		h.mu.RUnlock()

		if !exists {
			// Increment counter for next generation
			h.codeCounter++
			return code
		}

		// Code exists (collision), try next counter value
		h.codeCounter++
	}

	// Fallback: if too many collisions, use pure random with tracking
	for i := 0; i < 100; i++ {
		b := make([]byte, 3)
		rand.Read(b)
		codeNum := int(b[0])<<16 | int(b[1])<<8 | int(b[2])
		codeNum = codeNum % 1000000
		code := fmt.Sprintf("%06d", codeNum)

		h.mu.RLock()
		_, exists := h.rooms[code]
		h.mu.RUnlock()

		if !exists {
			h.codeCounter++
			return code
		}
	}

	// Last resort: sequential search (should never happen)
	for i := 0; i < 1000000; i++ {
		code := fmt.Sprintf("%06d", i)
		h.mu.RLock()
		_, exists := h.rooms[code]
		h.mu.RUnlock()
		if !exists {
			return code
		}
	}

	return "000000"
}

func (h *Hub) generateToken() string {
	b := make([]byte, 16)
	rand.Read(b)
	return fmt.Sprintf("%x", b)
}

func (h *Hub) sendError(c *Client, msg string) {
	resp, _ := json.Marshal(map[string]interface{}{
		"type": "ERROR",
		"payload": map[string]string{
			"message": msg,
		},
	})
	c.send <- resp
}

// HTTP Handlers

func (h *Hub) HandleListRooms(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	type RoomInfo struct {
		ID      string `json:"id"` // Code
		Name    string `json:"name"`
		Players int    `json:"players_count"`
	}

	list := []RoomInfo{}
	for _, r := range h.rooms {
		// r.clients is not safe to read here directly without room lock?
		// For MVP, we might skip precise count or add a GetCount channel
		list = append(list, RoomInfo{
			ID:      r.code,
			Name:    r.name,
			Players: 0, // TODO: Implement safe count
		})
	}

	json.NewEncoder(w).Encode(list)
}

func (h *Hub) HandleCreateRoom(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	room, hostToken := h.CreateRoom(req.Name)

	json.NewEncoder(w).Encode(map[string]string{
		"room_code":  room.code,
		"host_token": hostToken,
	})
}

func (h *Hub) CloseRoom(code string) {
	h.mu.Lock()
	delete(h.rooms, code)
	h.mu.Unlock()
}
