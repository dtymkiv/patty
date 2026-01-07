package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"patty/server"
)

var addr = flag.String("addr", ":8000", "http service address")

func main() {
	flag.Parse()

	hub := server.NewHub()
	go hub.Run()

	// Get the directory where the binary is located
	ex, err := os.Executable()
	if err != nil {
		log.Printf("Warning: could not get executable path: %v. Using relative paths.", err)
		ex = "./server_bin"
	}
	binDir := filepath.Dir(ex)
	staticDir := filepath.Join(binDir, "static")
	indexPath := filepath.Join(staticDir, "index.html")

	log.Printf("Serving static files from: %s", staticDir)

	// Serve the extracted assets.json specially if needed, or just let static handle it if it's in static/
	// static/assets.json is already there.

	// Register static file handler first (more specific routes should be registered first)
	http.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir(staticDir))))
	
	// Register API routes before root handler
	http.HandleFunc("/api/rooms", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		hub.HandleListRooms(w, r)
	})
	
	http.HandleFunc("/api/create-room", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		hub.HandleCreateRoom(w, r)
	})

	// WebSocket endpoint
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		server.ServeWs(hub, w, r)
	})

	// Root handler - serve index.html for SPA routing (register last)
	// This will only be called if the request doesn't match /static/, /ws, or /api/*
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, indexPath)
	})


	log.Printf("Server starting on %s...", *addr)
	err = http.ListenAndServe(*addr, nil)
	if err != nil {
		log.Fatal("ListenAndServe: ", err)
	}
}
