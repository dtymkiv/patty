const { createApp } = Vue

createApp({
    data() {
        return {
            view: 'login', // login, lobby, room
            nickname: '',
            nicknameInput: '',
            isEditingNickname: false,

            // Lobby
            rooms: [],
            newRoomPassword: '',
            joinCodeInput: '',
            selectedGameType: 'drawing',

            // Room / Game
            currentRoomId: null, // Legacy ID support
            roomCode: null,      // 6-digit code
            roomToken: null,     // Host Token

            socket: null,
            players: [],
            messages: [],
            chatInput: '',

            // Client Identity
            clientId: Math.random().toString(36).substr(2, 9),

            gameState: 'lobby', // lobby, playing

            isHostDisconnected: false,
            hostLogic: null,

            isInputFocused: false,
            isMobileView: false,

            gameConfig: {
                round_duration: 60,
                points_to_win: 50,
                base_points: 10,
                turn_order: 'sequence',
                host_role: 'player', // 'player' or 'spectator'
                word_language: '',
                word_difficulty: ''
            },
            configTimeout: null,
            wordSetMetadata: { languages: {}, difficulties: {} },
            wordSets: {}, // Loaded full set for Host

            // Game State Data (Synced from Host / Server)
            gameStateData: {
                round: 0,
                drawer: null,
                phase: 'PRE_ROUND',
                timer_end: 0,
                time_left: 0,
                word: '',
                word_hints: '',
                scores: {},
                correct_guessers: []
            },
            timeLeft: 0,
            localTimerEnd: 0,
            timerInterval: null,

            // Canvas
            ctx: null,
            isDrawing: false,
            lastX: 0,
            lastY: 0,
            currentBrushColor: '#000000',
            drawColors: ['#000000', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF', '#FFFFFF', '#8B4513', '#FFA500'],
            strokeHistory: [],
            currentActionId: null,

            // UI State
            animatedResults: [],
            lastTurnResults: {},
            resultsScores: {},
            isDarkMode: true,
            notifications: [],
            isShaking: false,
            showLeaveModal: false,
            showPlayerLeaveModal: false, // Modal for non-host player leaving during game
            showPasswordModal: false, // Legacy support?
            showInviteModal: false,
            inviteLink: '',
            linkCopied: false,
            pendingRoomJoin: null,
            playersWithIncorrectGuess: new Set() // Track players who guessed incorrectly for animation
        }
    },
    computed: {
        amIHost() {
            const p = this.players.find(p => p.nickname === this.nickname);
            // Fallback: if I have token, I might be host, but rely on server state
            return p ? p.is_host : !!this.roomToken;
        },
        amIReady() {
            const p = this.players.find(p => p.nickname === this.nickname);
            return p ? p.is_ready : false;
        },
        canStart() {
            // Count active players (excluding host if spectator)
            const activePlayers = this.players.filter(p => {
                if (!p.connected) return false;
                if (p.is_host && this.gameConfig.host_role === 'spectator') return false;
                return true;
            });
            
            // If host is spectator, need 2 players; if host is player, need 1 player
            const minPlayers = this.gameConfig.host_role === 'spectator' ? 2 : 1;
            return activePlayers.length >= minPlayers;
        },
        amIDrawing() {
            // Host spectator never draws
            if (this.amIHost && this.gameConfig.host_role === 'spectator') return false;
            return this.gameStateData.drawer === this.nickname;
        },
        hasGuessed() {
            return this.gameStateData.correct_guessers && this.gameStateData.correct_guessers.includes(this.nickname);
        },
        sortedPlayers() {
            // Exclude host from leaderboard if spectator
            return [...this.players].filter(p => {
                if (p.is_host && this.gameConfig.host_role === 'spectator') return false;
                return true;
            }).sort((a, b) => b.score - a.score);
        },
        dynamicFontSize() {
            const word = this.amIDrawing ? this.gameStateData.word : this.gameStateData.word_hints;
            if (!word) return 24;
            const len = word.length;
            if (len === 0) return 24;
            const availableWidth = this.isMobileView ? 110 : 350;
            let size = Math.floor(availableWidth / (len * 0.8));
            const minSize = this.isMobileView ? 6 : 10;
            const maxSize = this.isMobileView ? 18 : 28;
            return Math.max(minSize, Math.min(maxSize, size));
        },
        hintCharStyle() {
            const totalChars = this.gameStateData.word_hints ? this.gameStateData.word_hints.length : 0;
            if (totalChars === 0) return {};
            const size = this.dynamicFontSize;
            return {
                fontSize: `${size}px`,
                width: `${Math.max(4, size * 0.7)}px`,
                height: `${size * 1.3}px`,
                borderBottomWidth: `${Math.max(1, size / 8)}px`,
                marginBottom: '1px'
            };
        },
        availableDifficulties() {
            const lang = this.gameConfig.word_language;
            const diffs = this.wordSetMetadata.difficulties || {};
            return diffs[lang] || [];
        },
        displayedMessages() {
            return this.isMobileView ? this.messages.slice(-3) : this.messages;
        },
        totalGuessers() {
            const hostIsPlayer = this.gameConfig.host_role === 'player';
            return this.players.filter(p => {
                if (!p.connected) return false;
                if (p.nickname === this.gameStateData.drawer) return false;
                if (p.is_host && !hostIsPlayer) return false;
                return true;
            }).length;
        }
    },
    watch: {
        gameState(newVal) {
            if (newVal === 'playing') {
                // Initialize canvas for both drawer and viewers
                // Viewers need it to see the strokes being drawn
                this.$nextTick(() => this.initCanvas());
            }
        },
        'gameConfig.word_language'(newVal) {
            if (!this.amIHost) return;
            const diffs = (this.wordSetMetadata.difficulties || {})[newVal] || [];
            if (diffs.length > 0 && !diffs.includes(this.gameConfig.word_difficulty)) {
                this.gameConfig.word_difficulty = diffs[0];
                this.updateConfig();
            } else if (diffs.length === 0) {
                this.gameConfig.word_difficulty = '';
                this.updateConfig();
            }
        },
        'gameStateData.phase'(newVal, oldVal) {
            if (newVal === 'DRAWER_PREPARING' && oldVal !== 'DRAWER_PREPARING') {
                this.startResultsAnimation();
            } else if (newVal !== 'DRAWER_PREPARING') {
                this.animatedResults = [];
            }
        }
    },
    mounted() {
        window.addEventListener('resize', this.handleResize);

        // Load Assets (Word Sets)
        fetch('/static/assets.json').then(r => r.json()).then(data => {
            this.wordSets = data.WORD_SETS;
            const langs = {};
            const diffs = {};
            for (const l in this.wordSets) {
                // Use proper language metadata with flags from LANGUAGE_METADATA
                langs[l] = data.LANGUAGE_METADATA?.[l] || l;
                diffs[l] = Object.keys(this.wordSets[l]);
            }
            this.wordSetMetadata = { languages: langs, difficulties: diffs };

            if (!this.gameConfig.word_language) {
                this.gameConfig.word_language = Object.keys(langs)[0];
                const d = diffs[this.gameConfig.word_language];
                if (d && d.length > 0) this.gameConfig.word_difficulty = d[0];
            }
        }).catch(e => console.error("Failed to load assets", e));

        // URL Params (Code)
        const urlParams = new URLSearchParams(window.location.search);
        const codeParam = urlParams.get('code');
        const roomParam = urlParams.get('room'); // Legacy support

        const targetCode = codeParam || roomParam;

        const savedNick = localStorage.getItem('nickname');
        const savedTheme = localStorage.getItem('theme');

        this.isDarkMode = savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches);
        this.updateThemeClass();

        if (savedNick) {
            this.nickname = savedNick;
            this.view = 'lobby'; // Default to lobby if we have a name

            const savedRoomCode = localStorage.getItem('roomCode');
            const savedRoomToken = localStorage.getItem('roomToken');

            if (targetCode) {
                this.joinCodeInput = targetCode;
                this.isEditingNickname = false;

                // If URL param matches saved session, restore token
                if (targetCode === savedRoomCode) {
                    this.roomCode = savedRoomCode;
                    this.roomToken = savedRoomToken;
                    this.connectWebSocket();
                } else {
                    // Joining a different room
                    this.joinRoomByCode();
                }
            } else if (savedRoomCode) {
                // Restore previous session
                this.roomCode = savedRoomCode;
                this.roomToken = savedRoomToken;
                this.connectWebSocket();
            } else {
                this.view = 'lobby';
            }
        } else if (targetCode) {
            this.joinCodeInput = targetCode;
            this.view = 'login';
        }
        this.checkMobile();

        // Timer Interval for local countdown
        this.timerInterval = setInterval(() => {
            if (this.gameStateData && this.gameStateData.timer_end > 0) {
                const now = Date.now() / 1000;
                this.timeLeft = Math.max(0, Math.ceil(this.gameStateData.timer_end - now));
            } else {
                this.timeLeft = 0;
            }
        }, 100);
    },
    methods: {
        checkMobile() {
            this.isMobileView = window.innerWidth < 1024;
        },
        generateRandomName() {
            const adjectives = ['Happy', 'Silly', 'Brave', 'Clever', 'Swift', 'Mighty'];
            const nouns = ['Panda', 'Tiger', 'Eagle', 'Fox', 'Wolf', 'Bear'];
            const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
            const noun = nouns[Math.floor(Math.random() * nouns.length)];
            this.nicknameInput = `${adj}${noun}`;
        },
        setNickname() {
            if (!this.nicknameInput.trim()) return;
            this.nickname = this.nicknameInput.trim();
            localStorage.setItem('nickname', this.nickname);

            if (this.joinCodeInput && this.joinCodeInput.length === 6) {
                this.joinRoomByCode();
            } else {
                this.view = 'lobby';
            }
        },
        startEditingNickname() {
            this.nicknameInput = this.nickname;
            this.isEditingNickname = true;
        },
        saveNickname() {
            if (!this.nicknameInput.trim()) {
                this.cancelEditingNickname();
                return;
            }
            this.nickname = this.nicknameInput.trim();
            localStorage.setItem('nickname', this.nickname);
            this.isEditingNickname = false;
        },
        cancelEditingNickname() {
            this.isEditingNickname = false;
            this.nicknameInput = '';
        },
        async createRoom() {
            // Ensure any existing connection is closed first
            if (this.socket) {
                this.socket.onclose = null;
                this.socket.onmessage = null;
                this.socket.onerror = null;
                if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
                    this.socket.close();
                }
                this.socket = null;
            }
            
            // Clear any existing room state
            this.roomCode = null;
            this.roomToken = null;
            this.hostLogic = null;
            this.players = [];
            this.messages = [];
            
            try {
                const res = await fetch('/api/create-room', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: "Game Room" })
                });
                const data = await res.json();

                this.roomCode = data.room_code;
                this.roomToken = data.host_token;

                this.initHostLogic();
                await this.connectWebSocket();
            } catch (e) {
                console.error("createRoom error:", e);
                this.showNotification("Failed to create room", "error");
            }
        },
        joinRoomByCode() {
            if (this.joinCodeInput.length !== 6) return;
            this.roomCode = this.joinCodeInput;
            this.roomToken = null; // Join as player
            this.connectWebSocket();
        },
        initHostLogic() {
            // Use global GameHost class
            this.hostLogic = new GameHost(
                (type, payload) => {
                    // Broadcast via Server
                    if (!this.socket) return;
                    this.socket.send(JSON.stringify({ type: type, payload: payload }));
                    // Local Echo
                    this.processClientMessage({ type, payload });
                },
                (targetId, type, payload) => {
                    if (!this.socket) return;
                    this.socket.send(JSON.stringify({
                        type: "TARGETED_MESSAGE",
                        target: targetId, // Use Nickname
                        nested_type: type,
                        payload: payload
                    }));
                    // Local Echo if target is self
                    if (targetId === this.nickname) {
                        this.processClientMessage({ type: "TARGETED_MESSAGE", target: targetId, nested_type: type, payload });
                    }
                },
                this.roomCode
            );

            const restored = this.hostLogic.loadState();

            // Ensure Host is in hostLogic.players even if joined yet
            if (!this.hostLogic.players[this.nickname]) {
                this.hostLogic.addPlayer(this.nickname, true);
            } else {
                // Ensure host has a color
                this.hostLogic.assignColor(this.nickname);
            }

            // Initialize with current players data
            this.players.forEach(p => {
                const existing = restored ? this.hostLogic.players[p.nickname] : null;
                if (existing) {
                    existing.connected = true;
                    // Ensure color is assigned
                    if (!existing.color) {
                        this.hostLogic.assignColor(p.nickname);
                    }
                } else {
                    this.hostLogic.addPlayer(p.nickname, !!p.is_host);
                }
            });

            if (restored) {
                // Sync UI with restored state
                this.players = this.hostLogic.getPlayersList();
                this.gameStateData = this.hostLogic.state;
                this.gameConfig = this.hostLogic.config;
                this.gameState = this.gameStateData.phase === 'LOBBY' ? 'lobby' : 'playing';
                this.hostLogic.broadcastState();
            }
        },
        connectWebSocket() {
            return new Promise((resolve) => {
                const connect = () => {
                    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
                    const wsUrl = `${protocol}://${window.location.host}/ws`;
                    this.socket = new WebSocket(wsUrl);

                    this.socket.onopen = () => {
                        setTimeout(() => {
                            if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
                                resolve();
                                return;
                            }
                            const payload = {
                                room_code: this.roomCode,
                                nickname: this.nickname
                            };
                            if (this.roomToken) {
                                payload.host_token = this.roomToken;
                            }
                            try {
                                this.socket.send(JSON.stringify({
                                    type: "JOIN_ROOM",
                                    payload: payload
                                }));
                            } catch (e) {
                                console.error("Failed to send JOIN_ROOM:", e);
                            }
                            resolve();
                        }, 100);
                    };

                    this.socket.onmessage = (event) => {
                        const msg = JSON.parse(event.data);
                        this.handleMessage(msg);
                    };

                    this.socket.onerror = (error) => {
                        console.error("WebSocket error:", error);
                        resolve();
                    };

                    this.socket.onclose = (event) => {
                        if (this.view === 'room') {
                            this.showNotification("Disconnected", "error");
                            this.isHostDisconnected = true;
                        }
                    };
                };
                
                if (this.socket) {
                    const oldSocket = this.socket;
                    const wasOpen = oldSocket.readyState === WebSocket.OPEN || oldSocket.readyState === WebSocket.CONNECTING;
                    
                    oldSocket.onopen = null;
                    oldSocket.onmessage = null;
                    oldSocket.onerror = null;
                    oldSocket.onclose = () => {
                        setTimeout(connect, 100);
                    };
                    
                    if (wasOpen) {
                        oldSocket.close();
                    } else {
                        setTimeout(connect, 100);
                    }
                } else {
                    connect();
                }
            });
        },
        handleMessage(msg) {

            // --- Host Logic Integration ---
            if (this.amIHost && this.hostLogic) {
                if (msg.type === "CHAT") {
                    this.hostLogic.handleChat(msg.payload.sender, msg.payload.text);
                    return;
                }
                if (msg.type === "DRAW_STROKE") {
                    this.hostLogic.handleDraw(msg.payload);
                    return;
                }
                if (msg.type === "UNDO_STROKE") { this.hostLogic.handleUndo(); return; }
                if (msg.type === "CLEAR_CANVAS") { this.hostLogic.handleClear(); return; }
                if (msg.type === "START_GAME") { this.hostLogic.startGame(); return; }
                if (msg.type === "TOGGLE_READY") {
                    this.hostLogic.handleToggleReady(msg.payload.nickname);
                    return;
                }
                if (msg.type === "START_ACTIVE_ROUND") {
                    this.hostLogic.startActiveRound();
                    return;
                }
            }

            // --- Unified Client Handling ---
            this.processClientMessage(msg);
        },

        processClientMessage(msg) {
            if (msg.type === "JOIN_SUCCESS") {
                this.view = 'room';
                this.isHostDisconnected = false;
                this.roomCode = msg.payload.room_code;

                localStorage.setItem('roomCode', this.roomCode);
                if (msg.payload.is_host) {
                    this.roomToken = msg.payload.host_token || this.roomToken;
                    if (this.roomToken) localStorage.setItem('roomToken', this.roomToken);
                }

                const url = new URL(window.location);
                url.searchParams.set('code', this.roomCode);
                window.history.pushState({}, '', url);

                if (msg.payload.players) {
                    this.players = msg.payload.players.map(p => ({
                        nickname: p.nickname,
                        score: p.score || 0,
                        connected: true,
                        is_ready: !!p.is_ready,
                        is_host: !!p.is_host,
                        color: p.color || '#ea5128'
                    }));
                }

                if (msg.payload.is_host) {
                    if (!this.hostLogic) {
                        this.initHostLogic();
                        this.hostLogic.init(this.wordSets);
                    } else {
                        // Ensure existing hostLogic is aware of all current players
                        this.players.forEach(p => {
                            if (!this.hostLogic.players[p.nickname]) {
                        this.hostLogic.addPlayer(p.nickname, !!p.is_host);
                            }
                        });
                    }
                }
            } else if (msg.type === "PLAYER_JOINED") {
                const p = msg.payload;
                const existingPlayer = this.players.find(x => x.nickname === p.nickname);
                const wasDisconnected = existingPlayer && !existingPlayer.connected;
                
                if (!existingPlayer) {
                    this.players.push({
                        nickname: p.nickname,
                        score: 0,
                        connected: true,
                        is_ready: false,
                        is_host: p.is_host
                    });
                    // Show notification for new player joining
                    if (p.nickname !== this.nickname) {
                        this.showNotification(`${p.nickname} joined`, 'info');
                    }
                } else {
                    // Player already exists - update connection status
                    existingPlayer.connected = true;
                    existingPlayer.is_host = p.is_host;
                    // Show notification if player was disconnected and now reconnected
                    if (wasDisconnected && p.nickname !== this.nickname) {
                        this.showNotification(`${p.nickname} reconnected`, 'success');
                    }
                }
                if (this.hostLogic) {
                    const player = this.players.find(x => x.nickname === p.nickname);
                    this.hostLogic.addPlayer(p.nickname, !!player.is_host);
                    if (wasDisconnected) {
                        // Update connected status in hostLogic
                        if (this.hostLogic.players[p.nickname]) {
                            this.hostLogic.players[p.nickname].connected = true;
                        }
                    }
                    this.hostLogic.broadcastState();
                }

            } else if (msg.type === "PLAYER_LEFT") {
                const nickname = msg.payload.nickname;
                const index = this.players.findIndex(p => p.nickname === nickname);
                if (index !== -1) {
                    this.players.splice(index, 1);
                    // Show notification for player intentionally leaving
                    if (nickname !== this.nickname) {
                        this.showNotification(`${nickname} left`, 'info');
                    }
                }
                if (this.hostLogic) {
                    this.hostLogic.removePlayer(nickname);
                    this.hostLogic.broadcastState();
                }
            } else if (msg.type === "PLAYER_RECONNECTED") {
                // Player reconnected during game - resend state to help them sync
                const nickname = msg.payload.nickname;
                if (nickname !== this.nickname && this.hostLogic) {
                    // Give them a moment to receive JOIN_SUCCESS, then send full state
                    setTimeout(() => {
                        this.hostLogic.broadcastState();
                    }, 100);
                }
            } else if (msg.type === "PLAYER_DISCONNECTED") {
                const nickname = msg.payload.nickname;
                let player = this.players.find(p => p.nickname === nickname);
                if (!player) {
                    // Player disconnected but not in our list yet - add them as disconnected
                    player = {
                        nickname: nickname,
                        score: 0,
                        connected: false,
                        is_ready: false,
                        is_host: false
                    };
                    this.players.push(player);
                } else {
                    player.connected = false;
                }
                // Show notification for player disconnecting (can reconnect)
                if (nickname !== this.nickname) {
                    this.showNotification(`${nickname} disconnected`, 'warning');
                }
                if (this.hostLogic) {
                    if (!this.hostLogic.players[nickname]) {
                        this.hostLogic.addPlayer(nickname, false);
                    }
                    this.hostLogic.players[nickname].connected = false;
                    this.hostLogic.broadcastState();
                }

            } else if (msg.type === "GAME_STATE_UPDATE") {
                this.gameState = msg.payload.game_state.phase === 'LOBBY' ? 'lobby' : 'playing';
                this.gameStateData = msg.payload.game_state;

                if (msg.payload.players) {
                    this.players = msg.payload.players.map(p => ({
                        nickname: p.nickname,
                        score: p.score !== undefined ? p.score : 0,
                        connected: p.connected !== undefined ? p.connected : true,
                        is_ready: !!p.is_ready,
                        is_host: !!p.is_host,
                        color: p.color || '#ea5128',
                        has_guessed_correctly: !!p.has_guessed_correctly,
                        is_spectator: !!p.is_spectator
                    }));
                } else {
                    const scores = msg.payload.scores;
                    this.players.forEach(p => {
                        if (scores[p.nickname] !== undefined) p.score = scores[p.nickname];
                    });
                }
                if (msg.payload.config) {
                    this.gameConfig = { ...this.gameConfig, ...msg.payload.config };
                }

                // Canvas Init & Clears - Initialize canvas early if needed
                this.$nextTick(() => {
                    if (!this.ctx) this.initCanvas();
                    
                    // Clear canvas on phase transitions (new round starting)
                    if (msg.payload.game_state.phase === 'DRAWER_PREPARING' || msg.payload.game_state.phase === 'PRE_ROUND') {
                        this.performClear();
                    }
                });

                // Update stroke history from game state if available
                if (msg.payload.game_state.stroke_history && Array.isArray(msg.payload.game_state.stroke_history)) {
                    this.strokeHistory = msg.payload.game_state.stroke_history;
                    // Redraw canvas with the received stroke history
                    this.$nextTick(() => {
                        if (this.ctx) {
                            this.redrawFromHistory(this.strokeHistory);
                        }
                    });
                }
                
                // Clear incorrect guess tracking when a new DRAWING phase starts
                if (msg.payload.game_state.phase === 'DRAWING') {
                    this.playersWithIncorrectGuess.clear();
                }
            } else if (msg.type === "TARGETED_MESSAGE") {
                if (msg.target === this.nickname) {
                    if (msg.nested_type === "DRAWER_SECRET") {
                        this.gameStateData.word = msg.payload.word;
                    }
                }
            } else if (msg.type === "HOST_DISCONNECTED") {
                this.isHostDisconnected = true;
                if (!this.amIHost) {
                    this.showNotification("Host disconnected", 'warning');
                }
            } else if (msg.type === "HOST_RECONNECTED") {
                this.isHostDisconnected = false;
                if (!this.amIHost) {
                    this.showNotification("Host reconnected", 'success');
                }
            } else if (msg.type === "CHAT") {
                this.messages.push(msg.payload);
                this.$nextTick(() => {
                    const el = document.getElementById('chat-box');
                    if (el) el.scrollTop = el.scrollHeight;
                });

                // Success notification for others' correct guesses
                if (msg.payload.sender === 'System' && msg.payload.text.includes("guessed correctly!")) {
                    if (!msg.payload.text.startsWith(this.nickname + ' ')) {
                        this.showNotification(msg.payload.text, 'success');
                    }
                }

                // Shake effect for own incorrect guess
                if (msg.payload.sender === this.nickname && msg.payload.text === "guessed incorrectly") {
                    this.isShaking = true;
                    setTimeout(() => this.isShaking = false, 500);
                }

                // Track incorrect guesses for other players in player list
                if (msg.payload.text === "guessed incorrectly" && msg.payload.sender !== this.nickname) {
                    this.playersWithIncorrectGuess.add(msg.payload.sender);
                    // Remove the flag after animation completes
                    setTimeout(() => {
                        this.playersWithIncorrectGuess.delete(msg.payload.sender);
                    }, 400);
                }
            } else if (msg.type === "DRAW_STROKE") {
                this.drawStroke(msg.payload.x1, msg.payload.y1, msg.payload.x2, msg.payload.y2, msg.payload.color);
            } else if (msg.type === "CLEAR_CANVAS") {
                this.performClear();
            } else if (msg.type === "STROKE_HISTORY_UPDATE") {
                this.strokeHistory = msg.payload.history;
                this.redrawFromHistory(this.strokeHistory);
            }
            else if (msg.type === "CONFIG_UPDATE") {
                this.gameConfig = msg.payload.config;
            }
            else if (msg.type === "LEFT_ROOM") {
                // Confirmation that we successfully left the room
                this.cleanupRoom();
                this.closeSocket();
            } else if (msg.type === "ERROR") {
                const errorMsg = msg.payload.message;
                this.showNotification(errorMsg, "error");
                
                if (errorMsg === "Room not found") {
                    this.leaveRoom();
                } else if (errorMsg === "Nickname already taken") {
                    // Keep modal/view open, don't switch views
                    // User can change nickname and try again
                    return;
                }
            } else if (msg.type === "ROOM_CLOSED") {
                this.showNotification("Room closed by host", 'error');
                if (this.socket) {
                    this.socket.onclose = null;
                    this.socket.close();
                    this.socket = null;
                }
                this.leaveRoom();
            }
        },

        // HOST ACTIONS
        startGame() {
            if (this.hostLogic) this.hostLogic.startGame();
        },
        startActiveRound() {
            if (this.socket) {
                this.socket.send(JSON.stringify({ type: "START_ACTIVE_ROUND", payload: {} }));
            }
            if (this.amIHost && this.hostLogic) {
                this.hostLogic.startActiveRound();
            }
        },
        updateConfig() {
            if (this.hostLogic) this.hostLogic.setConfig(this.gameConfig);
        },
        setHostRole(role) {
            if (!this.amIHost) return;
            this.gameConfig.host_role = role;
            this.updateConfig();
        },
        setTurnOrder(order) {
            if (!this.amIHost) return;
            this.gameConfig.turn_order = order;
            this.updateConfig();
        },

        // CLIENT ACTIONS
        sendChat() {
            if (!this.chatInput.trim() || !this.socket) return;
            const payload = { text: this.chatInput, sender: this.nickname };
            this.socket.send(JSON.stringify({
                type: "CHAT",
                payload: payload
            }));
            // Local processing if Host (Server won't echo back to Host)
            if (this.amIHost && this.hostLogic) {
                this.hostLogic.handleChat(this.nickname, this.chatInput);
            }
            this.chatInput = '';
        },
        toggleReady() {
            if (!this.socket) return;
            const msg = {
                type: "TOGGLE_READY",
                payload: { nickname: this.nickname }
            };
            this.socket.send(JSON.stringify(msg));

            // Local processing if Host (Server won't echo back to Host)
            if (this.amIHost && this.hostLogic) {
                this.hostLogic.handleToggleReady(this.nickname);
            }
        },

        // Helper Methods
        handleInputFocus() { this.isInputFocused = true; },
        handleInputBlur() { this.isInputFocused = false; },
        toggleTheme() {
            this.isDarkMode = !this.isDarkMode;
            localStorage.setItem('theme', this.isDarkMode ? 'dark' : 'light');
            this.updateThemeClass();
        },
        updateThemeClass() {
            if (this.isDarkMode) document.documentElement.classList.add('dark');
            else document.documentElement.classList.remove('dark');
        },
        handleResize() {
            this.checkMobile();
            if (this.ctx) this.redrawFromHistory(this.strokeHistory);
        },
        openInviteModal() {
            if (!this.roomCode) return;
            const baseUrl = window.location.origin;
            this.inviteLink = `${baseUrl}/?code=${this.roomCode}`;
            this.showInviteModal = true;
            this.$nextTick(() => this.generateQRCode());
        },
        generateQRCode() {
            const container = document.getElementById('qrcode-container');
            if (container && typeof QRCode !== 'undefined') {
                container.innerHTML = '';
                new QRCode(container, {
                    text: this.inviteLink,
                    width: 256, height: 256,
                    colorDark: '#000000', colorLight: '#ffffff'
                });
            }
        },
        copyInviteLink() {
            navigator.clipboard.writeText(this.inviteLink);
            this.linkCopied = true;
            setTimeout(() => this.linkCopied = false, 2000);
        },
        closeInviteModal() { this.showInviteModal = false; },
        handleLeaveRequest() {
            if (this.amIHost) {
                this.showLeaveModal = true;
            } else if (this.gameState === 'playing') {
                // Non-host player leaving during active game - show warning modal
                this.showPlayerLeaveModal = true;
            } else {
                // Lobby or after game - just leave
                this.leaveRoom();
            }
        },
        confirmHostLeave() { this.leaveRoom(); },
        confirmPlayerLeave() { 
            this.showPlayerLeaveModal = false;
            this.leaveRoom(); 
        },
        leaveRoom() {
            // Prevent double-leaving
            if (this.view !== 'room') return;
            
            if (this.socket) {
                // Send LEAVE_ROOM message before closing (intentional leave)
                if (this.socket.readyState === WebSocket.OPEN) {
                    try {
                        if (this.amIHost) {
                            this.socket.send(JSON.stringify({ type: "CLOSE_ROOM", payload: {} }));
                            // Host closing room - cleanup immediately
                            this.cleanupRoom();
                            setTimeout(() => {
                                this.closeSocket();
                            }, 100);
                        } else {
                            this.socket.send(JSON.stringify({ type: "LEAVE_ROOM", payload: {} }));
                            // Wait for LEFT_ROOM confirmation from server
                            // If no confirmation after 500ms, cleanup anyway
                            setTimeout(() => {
                                if (this.view === 'room') {
                                    this.cleanupRoom();
                                    this.closeSocket();
                                }
                            }, 500);
                        }
                        return;
                    } catch (e) {
                        console.error("Failed to send leave message:", e);
                    }
                }
                this.closeSocket();
            }
            this.cleanupRoom();
        },
        closeSocket() {
            if (this.socket) {
                // Remove handlers to prevent interference
                this.socket.onopen = null;
                this.socket.onmessage = null;
                this.socket.onerror = null;
                this.socket.onclose = null;
                if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
                    this.socket.close();
                }
            }
            this.socket = null;
        },
        cleanupRoom() {
            this.socket = null;
            this.isHostDisconnected = false;
            this.hostLogic = null; // Fix ghost player state leakage
            this.showLeaveModal = false;
            this.showPlayerLeaveModal = false;
            this.showInviteModal = false;
            this.isEditingNickname = false;
            this.gameState = 'lobby'; // Reset game phase to fix re-creation bug
            this.view = this.nickname ? 'lobby' : 'login';
            this.messages = [];
            this.players = [];

            // Reset game state to close modals
            this.gameStateData = {
                round: 0,
                drawer: null,
                phase: 'LOBBY',
                timer_end: 0,
                time_left: 0,
                word: '',
                word_hints: '',
                scores: {},
                correct_guessers: []
            };

            // Clear persistence
            if (this.roomCode) {
                localStorage.removeItem(`host_state_${this.roomCode}`);
            }
            localStorage.removeItem('roomCode');
            localStorage.removeItem('roomToken');
            this.roomCode = null;
            this.roomToken = null;

            // Clear URL
            const url = new URL(window.location);
            url.searchParams.delete('code');
            window.history.pushState({}, '', url);
        },

        // Canvas methods
        initCanvas() {
            const canvas = this.$refs.gameCanvas;
            if (!canvas) {
                // Retry shortly if the ref isn't available yet
                setTimeout(() => this.initCanvas(), 50);
                return;
            }

            canvas.width = 2000;
            canvas.height = 1500;
            this.ctx = canvas.getContext('2d');
            this.ctx.lineCap = 'round';
            this.ctx.lineJoin = 'round';
            this.ctx.lineWidth = 15;

            canvas.addEventListener('mousedown', this.startDrawing);
            canvas.addEventListener('mousemove', this.draw);
            canvas.addEventListener('mouseup', this.stopDrawing);
            canvas.addEventListener('mouseout', this.stopDrawing);

            canvas.addEventListener('touchstart', (e) => {
                e.preventDefault();
                const touch = e.touches[0];
                const mouseEvent = new MouseEvent('mousedown', {
                    clientX: touch.clientX,
                    clientY: touch.clientY
                });
                canvas.dispatchEvent(mouseEvent);
            }, { passive: false });
            canvas.addEventListener('touchmove', (e) => {
                e.preventDefault();
                const touch = e.touches[0];
                const mouseEvent = new MouseEvent('mousemove', {
                    clientX: touch.clientX,
                    clientY: touch.clientY
                });
                canvas.dispatchEvent(mouseEvent);
            }, { passive: false });
            canvas.addEventListener('touchend', () => {
                const mouseEvent = new MouseEvent('mouseup', {});
                canvas.dispatchEvent(mouseEvent);
            });

            // Redraw if we already have history (e.g. from a sync message that arrived before init)
            if (this.strokeHistory.length > 0) {
                this.redrawFromHistory(this.strokeHistory);
            }
        },
        startDrawing(e) {
            if (!this.amIDrawing) return;
            this.isDrawing = true;
            this.currentActionId = Math.random().toString(36).substr(2, 9);
            const pos = this.getPos(e);
            this.lastX = pos.x; this.lastY = pos.y;
        },
        draw(e) {
            if (!this.isDrawing || !this.amIDrawing) return;
            const pos = this.getPos(e);

            const payload = { x1: this.lastX, y1: this.lastY, x2: pos.x, y2: pos.y, color: this.currentBrushColor, actionId: this.currentActionId };

            if (this.amIHost && this.hostLogic) {
                // Host Drawer: Draw locally AND update authoritative history and broadcast
                this.drawStroke(payload.x1, payload.y1, payload.x2, payload.y2, payload.color);
                this.hostLogic.handleDraw(payload);
            } else {
                // Player Drawer: Draw locally for latency and send to Host
                this.drawStroke(payload.x1, payload.y1, payload.x2, payload.y2, payload.color);
                this.socket.send(JSON.stringify({
                    type: "DRAW_STROKE",
                    payload: payload
                }));
            }

            this.lastX = pos.x;
            this.lastY = pos.y;
        },
        stopDrawing() { this.isDrawing = false; },
        drawStroke(x1, y1, x2, y2, color, fromHistory = false) {
            // Ensure canvas is initialized if not already done
            if (!this.ctx && this.$refs.gameCanvas) {
                this.initCanvas();
            }
            if (!this.ctx) return;
            
            const w = this.$refs.gameCanvas.width;
            const h = this.$refs.gameCanvas.height;
            this.ctx.beginPath();
            this.ctx.moveTo(x1 * w, y1 * h);
            this.ctx.lineTo(x2 * w, y2 * h);
            this.ctx.strokeStyle = color;
            this.ctx.lineWidth = 15;
            this.ctx.stroke();

            if (!fromHistory) {
                this.strokeHistory.push({ x1, y1, x2, y2, color });
            }
        },
        performClear() { if (this.ctx) this.ctx.clearRect(0, 0, 2000, 1500); this.strokeHistory = []; },
        clearCanvas() {
            if (!this.amIDrawing) return;
            if (this.amIHost && this.hostLogic) {
                this.hostLogic.handleClear();
            } else {
                this.socket.send(JSON.stringify({ type: "CLEAR_CANVAS", payload: {} }));
            }
        },
        undoStroke() {
            if (!this.amIDrawing) return;
            if (this.amIHost && this.hostLogic) {
                this.hostLogic.handleUndo();
            } else {
                this.socket.send(JSON.stringify({ type: "UNDO_STROKE", payload: {} }));
            }
        },
        setBrushColor(c) { this.currentBrushColor = c; },
        getPos(e) {
            const rect = this.$refs.gameCanvas.getBoundingClientRect();
            let x = (e.clientX - rect.left) / rect.width;
            let y = (e.clientY - rect.top) / rect.height;
            // Clamp to 0..1
            x = Math.max(0, Math.min(1, x));
            y = Math.max(0, Math.min(1, y));
            return { x, y };
        },
        redrawFromHistory(hist) {
            this.performClear();
            if (!hist) return;
            hist.forEach(s => this.drawStroke(s.x1, s.y1, s.x2, s.y2, s.color));
        },
        startResultsAnimation() {
            this.animatedResults = [];
            const results = this.gameStateData.turn_results || {};
            // Filter out empty results if any
            let updateList = [];

            // We want to show everyone involved in this turn's scoring
            // Usually just correct guessers + drawer

            // But we also want to be robust if turn_results is missing (e.g. late join)
            // If empty, show nothing?

            Object.entries(results).forEach(([nick, res]) => {
                updateList.push({
                    nickname: nick,
                    points: res.points,
                    time: res.time
                });
            });

            // Sort: Drawer first? or Highest points first?
            // Usually highest points looks best.
            updateList.sort((a, b) => b.points - a.points);

            this.animatedResults = updateList;
        },
        getPlayerColor(nickname) {
            const p = this.players.find(x => x.nickname === nickname);
            return p ? (p.color || '#ea5128') : '#ea5128';
        },
        getBaseScore(nickname) {
            // calculated score triggers animation, so "base" is score MINUS new points
            // But wait, the player.score is ALREADY updated by endRound in Host?
            // Yes, Host updates scores BEFORE broadcasting "DRAWER_PREPARING".
            // So this.players[].score includes the new points.
            // So Base = Score - NewPoints.

            const p = this.players.find(x => x.nickname === nickname);
            const currentScore = p ? p.score : 0;
            const res = (this.gameStateData.turn_results || {})[nickname];
            const newPoints = res ? res.points : 0;
            return Math.max(0, currentScore - newPoints);
        },
        getBaseScorePercentage(nickname) {
            const base = this.getBaseScore(nickname);
            const max = this.gameConfig.points_to_win || 50;
            return Math.min(100, (base / max) * 100);
        },
        getNewPointsPercentage(nickname) {
            const res = (this.gameStateData.turn_results || {})[nickname];
            const newPoints = res ? res.points : 0;
            const max = this.gameConfig.points_to_win || 50;
            return Math.min(100, (newPoints / max) * 100);
        },
        getRank(nickname) {
            // Calculate rank based on current total scores
            const sorted = [...this.players].sort((a, b) => b.score - a.score);
            const index = sorted.findIndex(p => p.nickname === nickname);
            return index + 1;
        },

        showNotification(msg, type = 'info') {
            const id = Math.random().toString(36).substr(2, 9);

            if (type === 'success') {
                // Success notifications (non-stacking, short duration)
                this.notifications = this.notifications.filter(n => n.type !== 'success');
                this.notifications.push({ id, message: msg, type });
                setTimeout(() => this.removeNotification(id), 2000);
            } else if (type === 'warning') {
                // Warning notifications (non-stacking, medium duration)
                this.notifications = this.notifications.filter(n => n.type !== 'warning');
                this.notifications.push({ id, message: msg, type });
                setTimeout(() => this.removeNotification(id), 2500);
            } else if (type === 'info') {
                // Info notifications (short duration)
                this.notifications.push({ id, message: msg, type });
                setTimeout(() => this.removeNotification(id), 2000);
            } else {
                // Error notifications stack (longer duration)
                this.notifications.push({ id, message: msg, type });
                setTimeout(() => this.removeNotification(id), 4000);
            }
        },
        removeNotification(id) {
            this.notifications = this.notifications.filter(n => n.id !== id);
        }
    }
}).mount('#app')

