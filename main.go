package main

import (
	"flag"
	"log"
	"net/http"

	"patty/server"
)

var addr = flag.String("addr", ":8000", "http service address")

func main() {
	flag.Parse()

	hub := server.NewHub()
	go hub.Run()

	// Serve the extracted assets.json specially if needed, or just let static handle it if it's in static/
	// static/assets.json is already there.

	http.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir("./static"))))
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "static/index.html")
	})

	// WebSocket endpoint
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		server.ServeWs(hub, w, r)
	})

	// Debug/Dev endpoint to list rooms (Optional, restricted in prod ideally)
	http.HandleFunc("/api/rooms", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		hub.HandleListRooms(w, r)
	})
	
	// Create Room Endpoint (POST)
	// Actually, creation happens via WebSocket "CREATE" message or HTTP?
	// The prompt implies "We will move a server...". Usually Create is HTTP->JSON. 
	// But simple WebSockets are fine too.
	// Let's stick to HTTP for Create to get the ID/Code, then Upgrade.
	// OR just Upgrade then send "CREATE".
	// The prompt says "generate 6-digit code". 
	// Let's use HTTP for Create to make it clean.
	http.HandleFunc("/api/create-room", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		hub.HandleCreateRoom(w, r)
	})

	log.Printf("Server starting on %s...", *addr)
	err := http.ListenAndServe(*addr, nil)
	if err != nil {
		log.Fatal("ListenAndServe: ", err)
	}
}
