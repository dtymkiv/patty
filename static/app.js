const { createApp } = Vue

createApp({
    data() {
        return {
            view: 'login', // login, lobby, room
            nickname: '',
            nicknameInput: '',
            isEditingNickname: false,
            lang: i18n.currentLang,

            // Lobby
            rooms: [],
            newRoomPassword: '',
            joinCodeInput: '',
            currentGameType: 'alligator', // Active game type in room

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
            hostLogicInitialized: false,
            assetsLoaded: false,

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
            isEraser: false,
            drawColors: ['#000000', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF', '#8B4513', '#FFA500'],
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
            showSettingsModal: false,
            inviteLink: '',
            linkCopied: false,
            pendingRoomJoin: null,
            playersWithIncorrectGuess: new Set(), // Track players who guessed incorrectly for animation
            resultsListNeedsScroll: false, // Track if results list needs scrolling

            // Telephone Game State
            telephoneState: {
                textInput: '',
                guessInput: '',
                currentAssignment: null, // { chainId, textToDraw/drawingToGuess }
                myStrokeHistory: []
            },
            telephoneConfig: {
                draw_duration: 90,
                guess_duration: 45,
                max_rounds: 0,
                host_role: 'player'
            },
            telephoneResultsView: {
                currentChainIndex: 0,
                currentStepIndex: 0,
                autoPlay: false
            }
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
            const hostRole = this.isTelephoneGame ? this.telephoneConfig.host_role : this.gameConfig.host_role;
            const activePlayers = this.players.filter(p => {
                if (!p.connected) return false;
                if (p.is_host && hostRole === 'spectator') return false;
                return true;
            });
            
            // Telephone needs 3 players, Alligator needs 2
            const minPlayers = this.isTelephoneGame ? 3 : 2;
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
        },
        myResultEntry() {
            // Get current player's result entry from animatedResults
            if (!this.animatedResults || this.animatedResults.length === 0) return null;
            // Don't show for host in spectator mode
            if (this.amIHost && this.gameConfig.host_role === 'spectator') return null;
            return this.animatedResults.find(res => res.nickname === this.nickname) || null;
        },
        // Telephone game computed
        isTelephoneGame() {
            return this.currentGameType === 'telephone';
        },
        telephonePhase() {
            return this.isTelephoneGame ? this.gameStateData.phase : null;
        },
        telephoneChains() {
            return this.gameStateData.chains || {};
        },
        chainKeys() {
            return Object.keys(this.telephoneChains);
        },
        currentChain() {
            if (!this.chainKeys.length) return null;
            const key = this.chainKeys[this.telephoneResultsView.currentChainIndex];
            return this.telephoneChains[key];
        },
        currentChainAuthor() {
            return this.chainKeys[this.telephoneResultsView.currentChainIndex] || '';
        },
        submittedPlayersCount() {
            if (!this.gameStateData.submissions) return 0;
            return Object.keys(this.gameStateData.submissions).length;
        },
        activePlayersCount() {
            return (this.gameStateData.activePlayers || []).length;
        },
        hasSubmittedTelephone() {
            return this.gameStateData.submissions && this.gameStateData.submissions[this.nickname];
        }
    },
    watch: {
        gameState(newVal) {
            if (newVal === 'playing') {
                // Initialize canvas for both drawer and viewers
                // Viewers need it to see the strokes being drawn
                this.$nextTick(() => {
                    this.initCanvas();
                    setTimeout(() => this.syncButtonSizes(), 100);
                });
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
        'animatedResults'() {
            // Check scroll when results change
            this.$nextTick(() => {
                setTimeout(() => this.checkResultsListScroll(), 100);
            });
        },
        // Telephone game watchers for reliable canvas updates
        'telephoneState.currentAssignment': {
            handler(newVal, oldVal) {
                if (!this.isTelephoneGame) return;
                if (!newVal) return;
                
                this.$nextTick(() => {
                    this.handleTelephoneAssignmentChange(newVal, oldVal);
                });
            },
            deep: true
        },
        'gameStateData.phase'(newVal, oldVal) {
            // Handle telephone game phase changes
            if (this.isTelephoneGame) {
                if (newVal === 'DRAWING' || newVal === 'GUESSING') {
                    // Request assignment if we don't have one for this phase
                    this.$nextTick(() => {
                        this.ensureTelephoneAssignment();
                    });
                }
            }
            
            // Existing alligator game logic
            if (newVal === 'DRAWER_PREPARING' && oldVal !== 'DRAWER_PREPARING') {
                this.startResultsAnimation();
                this.$nextTick(() => {
                    setTimeout(() => this.checkResultsListScroll(), 100);
                });
                if (this.amIDrawing) {
                    this.$nextTick(() => {
                        setTimeout(() => this.syncButtonSizes(), 200);
                    });
                }
            } else if (newVal !== 'DRAWER_PREPARING') {
                this.animatedResults = [];
                this.resultsListNeedsScroll = false;
            }
            if (newVal === 'DRAWING' && this.amIDrawing) {
                this.$nextTick(() => {
                    setTimeout(() => this.syncButtonSizes(), 150);
                });
            }
        },
        amIDrawing(newVal) {
            if (newVal) {
                // When drawing starts, sync button sizes with longer delay to ensure DOM is ready
                this.$nextTick(() => {
                    setTimeout(() => this.syncButtonSizes(), 150);
                });
            }
        },
        'gameStateData.drawer'(newVal) {
            // When drawer changes, sync button sizes if we're the new drawer
            if (newVal === this.nickname) {
                this.$nextTick(() => {
                    setTimeout(() => this.syncButtonSizes(), 150);
                });
            }
        },
        'telephonePhase'(newVal, oldVal) {
            // Initialize canvas for drawing phase
            if (newVal === 'DRAWING') {
                this.$nextTick(() => {
                    this.initCanvas();
                    this.performClear();
                });
            }
            // Initialize canvas for guessing phase (to show drawing)
            if (newVal === 'GUESSING') {
                this.$nextTick(() => {
                    this.initCanvas();
                });
            }
            // Render chain drawings when entering results
            if (newVal === 'RESULTS' || newVal === 'GAME_OVER') {
                this.telephoneResultsView.currentChainIndex = 0;
                this.telephoneResultsView.currentStepIndex = 0;
                this.$nextTick(() => {
                    setTimeout(() => this.renderChainDrawings(), 200);
                });
            }
        }
    },
    mounted() {
        window.addEventListener('resize', this.handleResize);

        // Clean up stale state entries from localStorage
        const savedRoomCode = localStorage.getItem('roomCode');
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const key = localStorage.key(i);
            if (key?.startsWith('host_state_') || key?.startsWith('telephone_state_')) {
                const roomCode = key.replace('host_state_', '').replace('telephone_state_', '');
                if (roomCode !== savedRoomCode) {
                    localStorage.removeItem(key);
                }
            }
        }

        // Load Assets (Word Sets)
        this.assetsLoaded = false;
        fetch('/static/assets.json')
            .then(r => {
                if (!r.ok) {
                    throw new Error(`Failed to load assets: ${r.status} ${r.statusText}`);
                }
                return r.json();
            })
            .then(data => {
                if (!data.WORD_SETS || Object.keys(data.WORD_SETS).length === 0) {
                    throw new Error("Word sets data is empty or invalid");
                }
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
                this.assetsLoaded = true;
                // If host logic was already initialized before assets loaded, initialize it now
                if (this.hostLogic && !this.hostLogicInitialized) {
                    this.hostLogic.init(this.wordSets);
                    this.hostLogicInitialized = true;
                }
            })
            .catch(e => {
                console.error("Failed to load assets", e);
                this.showNotification(this.t('failedToLoad'), "error");
                this.assetsLoaded = false;
            });

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

        // Sync button sizes after initial render
        setTimeout(() => this.syncButtonSizes(), 200);
    },
    methods: {
        t(key) {
            return translations[this.lang]?.[key] || translations.en[key] || key;
        },
        setLang(lang) {
            i18n.setLang(lang);
            this.lang = lang;
        },
        getLanguages() {
            return i18n.getLanguages();
        },
        getLangName(code) {
            return i18n.getLangName(code);
        },
        checkMobile() {
            this.isMobileView = window.innerWidth < 1024;
        },
        generateRandomName() {
            const adjectives = this.t('adjectives');
            const nouns = this.t('nouns');
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
        async createRoom(gameType = 'alligator') {
            this.currentGameType = gameType;
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
                this.showNotification(this.t('failedToCreate'), "error");
            }
        },
        joinRoomByCode() {
            const sanitized = (this.joinCodeInput || '').replace(/\D/g, '');
            this.joinCodeInput = sanitized;
            if (sanitized.length !== 6) return;
            this.roomCode = sanitized;
            this.roomToken = null; // Join as player
            this.connectWebSocket();
        },
        handleJoinCodeInput(event) {
            const digits = (event.target.value || '').replace(/\D/g, '').slice(0, 6);
            if (this.joinCodeInput !== digits) {
                this.joinCodeInput = digits;
            }
            event.target.value = digits;
        },
        initHostLogic() {
            // Check for saved state to determine game type
            const savedTelephone = localStorage.getItem(`telephone_state_${this.roomCode}`);
            const savedAlligator = localStorage.getItem(`host_state_${this.roomCode}`);
            
            // Determine game type from saved state if available
            if (savedTelephone) {
                try {
                    const data = JSON.parse(savedTelephone);
                    if (data.gameType === 'telephone' && data.state && data.state.phase !== 'LOBBY') {
                        this.currentGameType = 'telephone';
                    }
                } catch (e) {}
            }
            
            // Initialize based on game type
            const HostClass = this.currentGameType === 'telephone' ? TelephoneHost : GameHost;
            this.hostLogic = new HostClass(
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
                const oldPhase = this.gameStateData.phase;
                // Create a shallow copy to trigger Vue reactivity
                this.gameStateData = { ...this.hostLogic.state };
                this.gameState = this.gameStateData.phase === 'LOBBY' ? 'lobby' : 'playing';
                
                // Handle telephone game restoration - same pattern as Alligator
                if (this.currentGameType === 'telephone') {
                    this.telephoneConfig = this.hostLogic.config;
                    
                    // Restore current assignment (same as Alligator syncs drawer/word)
                    if (this.gameStateData.currentAssignments && this.gameStateData.currentAssignments[this.nickname]) {
                        this.telephoneState.currentAssignment = this.gameStateData.currentAssignments[this.nickname];
                    }
                    
                    // Sync stroke history from restored state - SAME PATTERN AS ALLIGATOR
                    if (this.gameStateData.strokeHistories && this.gameStateData.strokeHistories[this.nickname]) {
                        this.telephoneState.myStrokeHistory = this.gameStateData.strokeHistories[this.nickname];
                        if (this.telephoneState.myStrokeHistory.length > 0) {
                            setTimeout(() => {
                                if (!this.ctx) this.initCanvas();
                                if (this.ctx && this.telephoneState.myStrokeHistory.length > 0) {
                                    this.redrawFromHistory(this.telephoneState.myStrokeHistory);
                                }
                            }, 100);
                        }
                    }
                    
                    // For GUESSING phase, draw the image to guess
                    if (this.gameStateData.phase === 'GUESSING' && this.telephoneState.currentAssignment?.drawingToGuess) {
                        setTimeout(() => {
                            if (!this.ctx) this.initCanvas();
                            if (this.ctx) {
                                this.redrawFromHistory(this.telephoneState.currentAssignment.drawingToGuess);
                            }
                        }, 100);
                    }
                    
                    this.hostLogic.broadcastState();
                    setTimeout(() => {
                        this.hostLogic.resendAssignments();
                    }, 200);
                } else {
                    // Alligator game restoration
                    this.gameConfig = this.hostLogic.config;
                    
                    // Sync stroke history from restored state and redraw canvas
                    if (this.gameStateData.stroke_history && Array.isArray(this.gameStateData.stroke_history)) {
                        this.strokeHistory = this.gameStateData.stroke_history;
                        if (this.amIHost && this.strokeHistory.length > 0) {
                            setTimeout(() => {
                                if (!this.ctx) this.initCanvas();
                                if (this.ctx && this.strokeHistory.length > 0) {
                                    this.redrawFromHistory(this.strokeHistory);
                                }
                            }, 100);
                        }
                    }
                    
                    // Trigger results animation if phase is DRAWER_PREPARING
                    if (this.gameStateData.phase === 'DRAWER_PREPARING') {
                        this.$nextTick(() => {
                            this.startResultsAnimation();
                        });
                    }
                    
                    this.hostLogic.broadcastState();
                    
                    // Ensure timer is running after reconnection during DRAWING phase
                    if (this.gameStateData.phase === 'DRAWING' && this.gameStateData.timer_end > 0 && !this.hostLogic.timerInterval) {
                        const now = Date.now() / 1000;
                        if (now < this.gameStateData.timer_end) {
                            this.hostLogic.timerInterval = setInterval(() => {
                                this.hostLogic.checkTimer();
                            }, 1000);
                        } else {
                            this.hostLogic.endRound();
                        }
                    }
                }
            }

            // Initialize wordSets if assets are already loaded (alligator only)
            if (this.currentGameType === 'alligator' && this.assetsLoaded && this.wordSets && Object.keys(this.wordSets).length > 0) {
                this.hostLogic.init(this.wordSets);
                this.hostLogicInitialized = true;
            } else if (this.currentGameType === 'telephone') {
                this.hostLogic.init();
                this.hostLogicInitialized = true;
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
                            this.showNotification(this.t('disconnected'), "error");
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
                // Telephone game handlers - check if hostLogic has telephone methods
                const isTelephoneHost = this.hostLogic.handleDrawStroke !== undefined;
                if (isTelephoneHost) {
                    if (msg.type === "TEXT_SUBMISSION") {
                        this.hostLogic.handleTextSubmission(msg.payload.sender, msg.payload.text);
                        return;
                    }
                    if (msg.type === "GUESS_SUBMISSION") {
                        this.hostLogic.handleGuessSubmission(msg.payload.sender, msg.payload.guess);
                        return;
                    }
                    if (msg.type === "TELEPHONE_DRAW_STROKE") {
                        this.hostLogic.handleDrawStroke(msg.payload.sender, msg.payload.stroke);
                        return;
                    }
                    if (msg.type === "TELEPHONE_CLEAR") {
                        this.hostLogic.handleClearCanvas(msg.payload.sender);
                        return;
                    }
                    if (msg.type === "TELEPHONE_UNDO") {
                        this.hostLogic.handleUndo(msg.payload.sender);
                        return;
                    }
                    if (msg.type === "TELEPHONE_STROKE_SYNC") {
                        this.hostLogic.syncStrokeHistory(msg.payload.sender, msg.payload.history);
                        return;
                    }
                    if (msg.type === "REQUEST_ASSIGNMENT") {
                        this.hostLogic.resendAssignmentToPlayer(msg.payload.sender);
                        return;
                    }
                    if (msg.type === "NEXT_RESULT_STEP") {
                        this.hostLogic.nextResultStep();
                        return;
                    }
                }
                if (msg.type === "DRAW_STROKE") {
                    // Host needs to draw on local canvas too (for reconnection scenarios)
                    // Draw locally first, then update authoritative state
                    const isEraser = msg.payload.isEraser || msg.payload.color === '#FFFFFF';
                    this.drawStroke(msg.payload.x1, msg.payload.y1, msg.payload.x2, msg.payload.y2, msg.payload.color, false, isEraser);
                    this.hostLogic.handleDraw(msg.payload);
                    // Sync local history from hostLogic (authoritative source)
                    this.strokeHistory = this.hostLogic.state.stroke_history || [];
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
                        // Only initialize if assets are already loaded, otherwise the assets fetch callback will do it
                        if (this.assetsLoaded) {
                            this.hostLogic.init(this.wordSets);
                            this.hostLogicInitialized = true;
                        }
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
                        this.showNotification(`${p.nickname} ${this.t('joined')}`, 'info');
                    }
                } else {
                    // Player already exists - update connection status
                    existingPlayer.connected = true;
                    existingPlayer.is_host = p.is_host;
                    // Show notification if player was disconnected and now reconnected
                    if (wasDisconnected && p.nickname !== this.nickname) {
                        this.showNotification(`${p.nickname} ${this.t('reconnected')}`, 'success');
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
                        // For telephone game, resend their assignment after reconnection
                        if (this.currentGameType === 'telephone' && this.hostLogic.resendAssignmentToPlayer) {
                            setTimeout(() => {
                                this.hostLogic.resendAssignmentToPlayer(p.nickname);
                            }, 200);
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
                        this.showNotification(`${nickname} ${this.t('left')}`, 'error');
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
                    // Update connected status
                    if (this.hostLogic.players[nickname]) {
                        this.hostLogic.players[nickname].connected = true;
                    }
                    // Give them a moment to receive JOIN_SUCCESS, then send full state
                    setTimeout(() => {
                        this.hostLogic.broadcastState();
                        // For telephone game, also resend their specific assignment
                        if (this.currentGameType === 'telephone' && this.hostLogic.resendAssignmentToPlayer) {
                            setTimeout(() => {
                                this.hostLogic.resendAssignmentToPlayer(nickname);
                            }, 100);
                        }
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
                    this.showNotification(`${nickname} ${this.t('disconnected').toLowerCase()}`, 'warning');
                }
                if (this.hostLogic) {
                    if (!this.hostLogic.players[nickname]) {
                        this.hostLogic.addPlayer(nickname, false);
                    }
                    this.hostLogic.players[nickname].connected = false;
                    this.hostLogic.broadcastState();
                }

            } else if (msg.type === "GAME_STATE_UPDATE") {
                // Handle game type from payload
                if (msg.payload.gameType) {
                    this.currentGameType = msg.payload.gameType;
                }
                
                this.gameState = msg.payload.game_state.phase === 'LOBBY' ? 'lobby' : 'playing';
                // Create a copy for Vue reactivity
                this.gameStateData = { ...msg.payload.game_state };

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
                    if (this.isTelephoneGame) {
                        this.telephoneConfig = { ...this.telephoneConfig, ...msg.payload.config };
                    } else {
                        this.gameConfig = { ...this.gameConfig, ...msg.payload.config };
                    }
                }

                // Canvas Init & Clears - Initialize canvas early if needed
                this.$nextTick(() => {
                    // Handle telephone game - SAME PATTERN AS ALLIGATOR
                    if (this.isTelephoneGame) {
                        // Restore current assignment from game state
                        const assignments = msg.payload.game_state.currentAssignments;
                        if (assignments && assignments[this.nickname]) {
                            this.telephoneState.currentAssignment = assignments[this.nickname];
                        }
                        
                        // Sync stroke history - SAME AS ALLIGATOR
                        const strokeHistories = msg.payload.game_state.strokeHistories;
                        const hasStrokeHistory = strokeHistories && strokeHistories[this.nickname] && strokeHistories[this.nickname].length > 0;
                        
                        if (hasStrokeHistory) {
                            this.telephoneState.myStrokeHistory = strokeHistories[this.nickname];
                        }
                        
                        // Initialize canvas and handle stroke history restoration - SAME AS ALLIGATOR
                        if (!this.ctx) {
                            this.initCanvas();
                        }
                        const phase = msg.payload.game_state.phase;
                        this.$nextTick(() => {
                            if (!this.ctx) return;
                            
                            if (phase === 'DRAWING') {
                                if (hasStrokeHistory) {
                                    this.redrawFromHistory(this.telephoneState.myStrokeHistory);
                                } else {
                                    // Clear stale canvas when reconnecting without saved strokes
                                    this.ctx.clearRect(0, 0, this.$refs.gameCanvas.width, this.$refs.gameCanvas.height);
                                }
                            } else if (phase === 'GUESSING') {
                                if (this.telephoneState.currentAssignment?.drawingToGuess) {
                                    this.redrawFromHistory(this.telephoneState.currentAssignment.drawingToGuess);
                                } else {
                                    this.ctx.clearRect(0, 0, this.$refs.gameCanvas.width, this.$refs.gameCanvas.height);
                                }
                            }
                        });
                        return;
                    }
                    
                    // Alligator game canvas handling
                    // Update stroke history from game state if available (do this first)
                    const hasStrokeHistory = msg.payload.game_state.stroke_history && Array.isArray(msg.payload.game_state.stroke_history) && msg.payload.game_state.stroke_history.length > 0;
                    
                    if (hasStrokeHistory) {
                        this.strokeHistory = msg.payload.game_state.stroke_history;
                    }
                    
                    // Initialize canvas and handle stroke history restoration
                    if (!this.ctx) {
                        this.initCanvas();
                    } else {
                        // Canvas already initialized, redraw if we have history
                        if (hasStrokeHistory) {
                            this.redrawFromHistory(this.strokeHistory);
                        }
                    }
                    
                    // Clear canvas on phase transitions (new round starting)
                    if ((msg.payload.game_state.phase === 'DRAWER_PREPARING' || msg.payload.game_state.phase === 'PRE_ROUND') 
                        && !hasStrokeHistory
                        && msg.payload.game_state.phase !== 'DRAWING') {
                        this.performClear();
                    }
                    
                    // Sync button sizes when drawer role changes and toolbar becomes visible
                    if (msg.payload.game_state.drawer === this.nickname && 
                        (msg.payload.game_state.phase === 'DRAWER_PREPARING' || msg.payload.game_state.phase === 'DRAWING')) {
                        setTimeout(() => this.syncButtonSizes(), 200);
                    }
                });
                
                // Clear incorrect guess tracking when a new DRAWING phase starts
                if (msg.payload.game_state.phase === 'DRAWING') {
                    this.playersWithIncorrectGuess.clear();
                }
            } else if (msg.type === "TARGETED_MESSAGE") {
                if (msg.target === this.nickname) {
                    if (msg.nested_type === "DRAWER_SECRET") {
                        this.gameStateData.word = msg.payload.word;
                    }
                    // Telephone game targeted messages
                    if (msg.nested_type === "DRAW_ASSIGNMENT") {
                        const current = this.telephoneState.currentAssignment;
                        const isNewStep = !current || current.stepNumber !== msg.payload.stepNumber;
                        const incomingHistory = msg.payload.strokeHistory || [];
                        
                        // Handle stroke history first (before updating assignment which triggers watcher)
                        if (incomingHistory.length > 0) {
                            // Reconnection case: restore from incoming history
                            this.telephoneState.myStrokeHistory = [...incomingHistory];
                        } else if (isNewStep) {
                            // New round: clear stroke history
                            this.telephoneState.myStrokeHistory = [];
                        }
                        
                        // Update assignment - this will trigger the watcher to handle canvas
                        this.telephoneState.currentAssignment = {
                            chainId: msg.payload.chainId,
                            textToDraw: msg.payload.textToDraw,
                            stepNumber: msg.payload.stepNumber
                        };
                    }
                    if (msg.nested_type === "GUESS_ASSIGNMENT") {
                        // Clear stroke history for guessing phase
                        this.telephoneState.myStrokeHistory = [];
                        
                        // Only clear guess if we don't already have one submitted
                        if (!this.hasSubmittedTelephone) {
                            this.telephoneState.guessInput = '';
                        }
                        
                        // Update assignment - this will trigger the watcher to handle canvas
                        this.telephoneState.currentAssignment = {
                            chainId: msg.payload.chainId,
                            drawingToGuess: msg.payload.drawingToGuess,
                            stepNumber: msg.payload.stepNumber
                        };
                    }
                    if (msg.nested_type === "STROKE_HISTORY_UPDATE") {
                        this.telephoneState.myStrokeHistory = [...(msg.payload.history || [])];
                        setTimeout(() => {
                            if (!this.ctx) this.initCanvas();
                            this.$nextTick(() => {
                                if (this.ctx && this.telephoneState.myStrokeHistory.length > 0) {
                                    this.redrawFromHistory(this.telephoneState.myStrokeHistory);
                                }
                            });
                        }, 100);
                    }
                }
            } else if (msg.type === "HOST_DISCONNECTED") {
                this.isHostDisconnected = true;
                if (!this.amIHost) {
                    this.showNotification(this.t('hostDisconnected'), 'warning');
                }
            } else if (msg.type === "HOST_RECONNECTED") {
                this.isHostDisconnected = false;
                if (!this.amIHost) {
                    this.showNotification(this.t('hostReconnected'), 'success');
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
                const isEraser = msg.payload.isEraser || msg.payload.color === '#FFFFFF';
                this.drawStroke(msg.payload.x1, msg.payload.y1, msg.payload.x2, msg.payload.y2, msg.payload.color, false, isEraser);
            } else if (msg.type === "CLEAR_CANVAS") {
                this.performClear();
            } else if (msg.type === "STROKE_HISTORY_UPDATE") {
                this.strokeHistory = msg.payload.history;
                this.redrawFromHistory(this.strokeHistory);
            }
            else if (msg.type === "CONFIG_UPDATE") {
                if (this.isTelephoneGame) {
                    this.telephoneConfig = { ...this.telephoneConfig, ...msg.payload.config };
                } else {
                    this.gameConfig = msg.payload.config;
                }
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
                this.showNotification(this.t('roomClosed'), 'error');
                if (this.socket) {
                    this.socket.onclose = null;
                    this.socket.close();
                    this.socket = null;
                }
                this.leaveRoom();
            }
        },

        // HOST ACTIONS
        setGameType(type) {
            if (this.gameState !== 'lobby') return;
            if (!this.amIHost) return;
            
            this.currentGameType = type;
            // Reinitialize host logic with new game type
            this.initHostLogic();
            if (type === 'alligator' && this.assetsLoaded) {
                this.hostLogic.init(this.wordSets);
                this.hostLogicInitialized = true;
            } else {
                this.hostLogic.init();
                this.hostLogicInitialized = true;
            }
            // Broadcast game type change to all players
            this.hostLogic.broadcastState();
        },
        startGame() {
            if (!this.hostLogic) {
                this.showNotification(this.t('gameLogicNotInit'), "error");
                return;
            }
            // Only check assets for alligator game
            if (this.currentGameType === 'alligator') {
                if (!this.assetsLoaded || !this.wordSets || Object.keys(this.wordSets).length === 0) {
                    this.showNotification(this.t('wordSetsLoading'), "error");
                    return;
                }
            }
            if (!this.hostLogicInitialized) {
                // Initialize hostLogic with wordSets if not already done
                this.hostLogic.init(this.wordSets);
                this.hostLogicInitialized = true;
            }
            // If game is over, reset to lobby first (preserves config and players)
            const isPostGamePhase = ['GAME_OVER', 'RESULTS'].includes(this.gameStateData.phase);
            if (isPostGamePhase) {
                // Check if resetToLobby method exists (for backwards compatibility)
                if (typeof this.hostLogic.resetToLobby === 'function') {
                    this.hostLogic.resetToLobby();
                } else {
                    // Fallback: manually reset state if method doesn't exist
                    this.hostLogic.state.phase = "LOBBY";
                    this.hostLogic.state.round = 0;
                    this.hostLogic.state.drawer = null;
                    this.hostLogic.state.last_drawer = null;
                    this.hostLogic.state.last_word = null;
                    this.hostLogic.state.word = null;
                    this.hostLogic.state.word_hints = null;
                    this.hostLogic.state.timer_end = 0;
                    this.hostLogic.state.time_left = 0;
                    this.hostLogic.state.correct_guessers = [];
                    this.hostLogic.state.turn_results = {};
                    this.hostLogic.state.stroke_history = [];
                    Object.values(this.hostLogic.players).forEach(p => {
                        p.score = 0;
                        p.is_ready = false;
                        p.has_guessed_correctly = false;
                    });
                    this.hostLogic.broadcastState();
                }
                // Clear canvas when resetting to lobby
                if (this.ctx) {
                    this.performClear();
                }
                // Wait a moment for state to sync, then start the game
                this.$nextTick(() => {
                    setTimeout(() => {
                        this.hostLogic.startGame();
                    }, 100);
                });
            } else {
                this.hostLogic.startGame();
            }
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

        // TELEPHONE ACTIONS
        submitTelephoneText() {
            if (!this.telephoneState.textInput.trim()) return;
            if (this.socket) {
                this.socket.send(JSON.stringify({
                    type: "TEXT_SUBMISSION",
                    payload: { sender: this.nickname, text: this.telephoneState.textInput }
                }));
            }
            if (this.amIHost && this.hostLogic) {
                this.hostLogic.handleTextSubmission(this.nickname, this.telephoneState.textInput);
            }
            this.telephoneState.textInput = '';
        },
        submitTelephoneGuess() {
            if (!this.telephoneState.guessInput.trim()) return;
            if (this.socket) {
                this.socket.send(JSON.stringify({
                    type: "GUESS_SUBMISSION",
                    payload: { sender: this.nickname, guess: this.telephoneState.guessInput }
                }));
            }
            if (this.amIHost && this.hostLogic) {
                this.hostLogic.handleGuessSubmission(this.nickname, this.telephoneState.guessInput);
            }
            this.telephoneState.guessInput = '';
        },
        telephoneDrawStroke(payload) {
            if (this.socket) {
                this.socket.send(JSON.stringify({
                    type: "TELEPHONE_DRAW_STROKE",
                    payload: { sender: this.nickname, stroke: payload }
                }));
            }
            if (this.amIHost && this.hostLogic) {
                this.hostLogic.handleDrawStroke(this.nickname, payload);
            }
            this.telephoneState.myStrokeHistory.push(payload);
        },
        telephoneClear() {
            if (this.socket) {
                this.socket.send(JSON.stringify({
                    type: "TELEPHONE_CLEAR",
                    payload: { sender: this.nickname }
                }));
            }
            if (this.amIHost && this.hostLogic) {
                this.hostLogic.handleClearCanvas(this.nickname);
            }
            this.telephoneState.myStrokeHistory = [];
            this.performClear();
        },
        telephoneUndo() {
            if (this.socket) {
                this.socket.send(JSON.stringify({
                    type: "TELEPHONE_UNDO",
                    payload: { sender: this.nickname }
                }));
            }
            if (this.amIHost && this.hostLogic) {
                this.hostLogic.handleUndo(this.nickname);
                this.telephoneState.myStrokeHistory = this.hostLogic.state.strokeHistories?.[this.nickname] || [];
                this.redrawFromHistory(this.telephoneState.myStrokeHistory);
            }
        },
        nextTelephoneResult() {
            if (this.amIHost && this.hostLogic) {
                this.hostLogic.nextResultStep();
            } else if (this.socket) {
                this.socket.send(JSON.stringify({
                    type: "NEXT_RESULT_STEP",
                    payload: {}
                }));
            }
        },
        // Local results navigation (for viewing chains)
        nextChainStep() {
            const chain = this.currentChain;
            if (!chain) return;
            
            if (this.telephoneResultsView.currentStepIndex < chain.steps.length - 1) {
                this.telephoneResultsView.currentStepIndex++;
                this.$nextTick(() => this.renderChainDrawings());
            }
        },
        prevChainStep() {
            if (this.telephoneResultsView.currentStepIndex > 0) {
                this.telephoneResultsView.currentStepIndex--;
            }
        },
        nextChain() {
            if (this.telephoneResultsView.currentChainIndex < this.chainKeys.length - 1) {
                this.telephoneResultsView.currentChainIndex++;
                this.telephoneResultsView.currentStepIndex = 0;
            }
            this.$nextTick(() => this.renderChainDrawings());
        },
        prevChain() {
            if (this.telephoneResultsView.currentChainIndex > 0) {
                this.telephoneResultsView.currentChainIndex--;
                this.telephoneResultsView.currentStepIndex = 0;
            }
            this.$nextTick(() => this.renderChainDrawings());
        },
        renderChainDrawings() {
            if (!this.currentChain) return;
            this.currentChain.steps.forEach((step, idx) => {
                if (step.type === 'drawing') {
                    const canvasRef = this.$refs['chainCanvas_' + idx];
                    if (canvasRef && canvasRef[0]) {
                        const canvas = canvasRef[0];
                        canvas.width = 2000;
                        canvas.height = 1500;
                        const ctx = canvas.getContext('2d');
                        ctx.lineCap = 'round';
                        ctx.lineJoin = 'round';
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        
                        if (Array.isArray(step.content)) {
                            step.content.forEach(s => {
                                ctx.beginPath();
                                ctx.moveTo(s.x1 * canvas.width, s.y1 * canvas.height);
                                ctx.lineTo(s.x2 * canvas.width, s.y2 * canvas.height);
                                if (s.isEraser || s.color === '#FFFFFF') {
                                    ctx.strokeStyle = '#FFFFFF';
                                    ctx.lineWidth = 45;
                                } else {
                                    ctx.strokeStyle = s.color;
                                    ctx.lineWidth = 15;
                                }
                                ctx.stroke();
                            });
                        }
                    }
                }
            });
        },
        updateTelephoneConfig() {
            if (this.hostLogic) this.hostLogic.setConfig(this.telephoneConfig);
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
            // Redraw appropriate history for game type
            if (this.ctx) {
                if (this.isTelephoneGame) {
                    if (this.gameStateData.phase === 'DRAWING') {
                        this.redrawFromHistory(this.telephoneState.myStrokeHistory);
                    } else if (this.gameStateData.phase === 'GUESSING' && this.telephoneState.currentAssignment?.drawingToGuess) {
                        this.redrawFromHistory(this.telephoneState.currentAssignment.drawingToGuess);
                    }
                } else {
                    this.redrawFromHistory(this.strokeHistory);
                }
            }
            this.syncButtonSizes();
            // Check if results list scroll state changed
            if (this.gameStateData.phase === 'DRAWER_PREPARING') {
                this.checkResultsListScroll();
            }
        },
        syncButtonSizes() {
            // Try multiple times with delays to ensure DOM is ready
            const attemptSync = (retries = 5) => {
                const colorPalette = document.querySelector('.color-palette-grid');
                const actionButtons = document.querySelectorAll('.drawing-actions-group .action-btn, .drawing-actions-group .color-btn');
                
                if (colorPalette && actionButtons.length > 0) {
                    const colorButton = colorPalette.querySelector('.color-btn');
                    if (colorButton) {
                        const computedStyle = window.getComputedStyle(colorButton);
                        let width = computedStyle.width;
                        let height = computedStyle.height;
                        
                        // Only sync if we got valid dimensions
                        if (width && height && width !== '0px' && height !== '0px') {
                            // Parse width/height and apply max size cap (2.5rem = 40px)
                            const maxSizePx = 40;
                            const widthPx = parseFloat(width);
                            const heightPx = parseFloat(height);
                            
                            // Cap at maximum size
                            const finalWidth = Math.min(widthPx, maxSizePx) + 'px';
                            const finalHeight = Math.min(heightPx, maxSizePx) + 'px';
                            
                            actionButtons.forEach(btn => {
                                btn.style.width = finalWidth;
                                btn.style.height = finalHeight;
                            });
                            return true;
                        }
                    }
                }
                
                // Retry if failed and retries left
                if (retries > 0) {
                    setTimeout(() => attemptSync(retries - 1), 100);
                }
                return false;
            };
            
            this.$nextTick(() => {
                attemptSync();
            });
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
            this.hostLogic = null;
            this.hostLogicInitialized = false;
            this.showLeaveModal = false;
            this.showPlayerLeaveModal = false;
            this.showInviteModal = false;
            this.isEditingNickname = false;
            this.gameState = 'lobby';
            this.currentGameType = 'alligator';
            this.view = this.nickname ? 'lobby' : 'login';
            this.messages = [];
            this.players = [];
            
            // Reset telephone state
            this.telephoneState = {
                textInput: '',
                guessInput: '',
                currentAssignment: null,
                myStrokeHistory: []
            };
            this.telephoneResultsView = {
                currentChainIndex: 0,
                currentStepIndex: 0,
                autoPlay: false
            };

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
                localStorage.removeItem(`telephone_state_${this.roomCode}`);
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
                // Check if drawing is allowed for current game type
                const canDraw = this.isTelephoneGame 
                    ? this.gameStateData.phase === 'DRAWING'
                    : this.amIDrawing;
                if (!canDraw) return;
                e.preventDefault();
                const touch = e.touches[0];
                const mouseEvent = new MouseEvent('mousedown', {
                    clientX: touch.clientX,
                    clientY: touch.clientY
                });
                canvas.dispatchEvent(mouseEvent);
            }, { passive: false });
            canvas.addEventListener('touchmove', (e) => {
                const canDraw = this.isTelephoneGame 
                    ? this.gameStateData.phase === 'DRAWING'
                    : this.amIDrawing;
                if (!canDraw) return;
                e.preventDefault();
                const touch = e.touches[0];
                const mouseEvent = new MouseEvent('mousemove', {
                    clientX: touch.clientX,
                    clientY: touch.clientY
                });
                canvas.dispatchEvent(mouseEvent);
            }, { passive: false });
            canvas.addEventListener('touchend', () => {
                const canDraw = this.isTelephoneGame 
                    ? this.gameStateData.phase === 'DRAWING'
                    : this.amIDrawing;
                if (!canDraw) return;
                const mouseEvent = new MouseEvent('mouseup', {});
                canvas.dispatchEvent(mouseEvent);
            });

            // Redraw if we already have history (e.g. from a sync message that arrived before init)
            if (this.isTelephoneGame) {
                // For telephone game, redraw based on phase
                if (this.gameStateData.phase === 'DRAWING' && this.telephoneState.myStrokeHistory.length > 0) {
                    this.redrawFromHistory(this.telephoneState.myStrokeHistory);
                } else if (this.gameStateData.phase === 'GUESSING' && this.telephoneState.currentAssignment?.drawingToGuess) {
                    this.redrawFromHistory(this.telephoneState.currentAssignment.drawingToGuess);
                }
            } else if (this.strokeHistory.length > 0) {
                this.redrawFromHistory(this.strokeHistory);
            }
        },
        startDrawing(e) {
            // For telephone game, allow drawing if in drawing phase
            if (this.isTelephoneGame) {
                if (this.gameStateData.phase !== 'DRAWING') return;
            } else {
                if (!this.amIDrawing) return;
            }
            this.isDrawing = true;
            this.currentActionId = Math.random().toString(36).substr(2, 9);
            const pos = this.getPos(e);
            this.lastX = pos.x; this.lastY = pos.y;
        },
        draw(e) {
            // For telephone game, check if we're in drawing phase
            if (this.isTelephoneGame) {
                if (!this.isDrawing || this.gameStateData.phase !== 'DRAWING') return;
                const pos = this.getPos(e);
                const strokeColor = this.isEraser ? '#FFFFFF' : this.currentBrushColor;
                const payload = { x1: this.lastX, y1: this.lastY, x2: pos.x, y2: pos.y, color: strokeColor, actionId: this.currentActionId, isEraser: this.isEraser };
                
                this.drawStroke(payload.x1, payload.y1, payload.x2, payload.y2, payload.color, false, payload.isEraser, payload.actionId);
                this.telephoneDrawStroke(payload);
                
                this.lastX = pos.x;
                this.lastY = pos.y;
                return;
            }
            
            if (!this.isDrawing || !this.amIDrawing) return;
            const pos = this.getPos(e);

            // Use white color for eraser mode
            const strokeColor = this.isEraser ? '#FFFFFF' : this.currentBrushColor;
            const payload = { x1: this.lastX, y1: this.lastY, x2: pos.x, y2: pos.y, color: strokeColor, actionId: this.currentActionId, isEraser: this.isEraser };

            if (this.amIHost && this.hostLogic) {
                // Host Drawer: Draw locally AND update authoritative history and broadcast
                this.drawStroke(payload.x1, payload.y1, payload.x2, payload.y2, payload.color, false, payload.isEraser, payload.actionId);
                this.hostLogic.handleDraw(payload);
                // Sync local history from hostLogic (authoritative source)
                this.strokeHistory = this.hostLogic.state.stroke_history || [];
            } else {
                // Player Drawer: Draw locally for latency and send to Host
                this.drawStroke(payload.x1, payload.y1, payload.x2, payload.y2, payload.color, false, payload.isEraser, payload.actionId);
                this.socket.send(JSON.stringify({
                    type: "DRAW_STROKE",
                    payload: payload
                }));
            }

            this.lastX = pos.x;
            this.lastY = pos.y;
        },
        stopDrawing() { 
            this.isDrawing = false; 
            // For telephone game, send full stroke history on mouseup to ensure host has latest state
            if (this.isTelephoneGame && this.gameStateData.phase === 'DRAWING' && this.telephoneState.myStrokeHistory.length > 0) {
                this.sendTelephoneStrokeHistorySync();
            }
        },
        sendTelephoneStrokeHistorySync() {
            // Send full stroke history to host for synchronization
            if (this.socket) {
                this.socket.send(JSON.stringify({
                    type: "TELEPHONE_STROKE_SYNC",
                    payload: { sender: this.nickname, history: this.telephoneState.myStrokeHistory }
                }));
            }
            if (this.amIHost && this.hostLogic) {
                // Host syncs directly
                this.hostLogic.syncStrokeHistory(this.nickname, this.telephoneState.myStrokeHistory);
            }
        },
        // Handle telephone assignment changes reactively (called by watcher)
        handleTelephoneAssignmentChange(newAssignment, oldAssignment) {
            if (!newAssignment) return;
            
            const phase = this.gameStateData.phase;
            const isNewStep = !oldAssignment || oldAssignment.stepNumber !== newAssignment.stepNumber;
            
            // Initialize canvas if needed
            if (!this.ctx) {
                this.initCanvas();
            }
            
            this.$nextTick(() => {
                if (!this.ctx) return;
                
                if (phase === 'DRAWING') {
                    // Clear canvas for new drawing round
                    this.ctx.clearRect(0, 0, this.$refs.gameCanvas.width, this.$refs.gameCanvas.height);
                    
                    // If we have stroke history, redraw it
                    if (this.telephoneState.myStrokeHistory.length > 0) {
                        this.redrawFromHistory(this.telephoneState.myStrokeHistory);
                    }
                } else if (phase === 'GUESSING' && newAssignment.drawingToGuess) {
                    // Clear and draw the image to guess
                    this.ctx.clearRect(0, 0, this.$refs.gameCanvas.width, this.$refs.gameCanvas.height);
                    this.redrawFromHistory(newAssignment.drawingToGuess);
                }
            });
        },
        // Ensure we have the correct assignment for current phase
        ensureTelephoneAssignment() {
            const phase = this.gameStateData.phase;
            const assignment = this.telephoneState.currentAssignment;
            
            // Check if we need to request assignment
            const needsAssignment = (phase === 'DRAWING' && (!assignment || !assignment.textToDraw)) ||
                                   (phase === 'GUESSING' && (!assignment || !assignment.drawingToGuess));
            
            if (needsAssignment) {
                // Request assignment from host
                this.requestTelephoneAssignment();
            } else {
                // We have the assignment, ensure canvas is updated
                this.handleTelephoneAssignmentChange(assignment, null);
            }
        },
        // Request current assignment from host
        requestTelephoneAssignment() {
            if (this.socket) {
                this.socket.send(JSON.stringify({
                    type: "REQUEST_ASSIGNMENT",
                    payload: { sender: this.nickname }
                }));
            }
            // If we're the host, handle directly
            if (this.amIHost && this.hostLogic && this.hostLogic.resendAssignmentToPlayer) {
                this.hostLogic.resendAssignmentToPlayer(this.nickname);
            }
        },
        drawStroke(x1, y1, x2, y2, color, fromHistory = false, isEraserStroke = false, actionId = null) {
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
            // Use eraser mode: white color with 3x line width
            // Check if it's an eraser stroke (either from current eraser mode or from received payload)
            // Also check if color is white (since white is no longer in color picker, white = eraser)
            const isEraser = isEraserStroke || (fromHistory && color === '#FFFFFF') || (!fromHistory && this.isEraser);
            if (isEraser) {
                this.ctx.strokeStyle = '#FFFFFF';
                this.ctx.lineWidth = 45;
            } else {
                this.ctx.strokeStyle = color;
                this.ctx.lineWidth = 15;
            }
            this.ctx.stroke();

            // Only add to local history if not from history and not host (host syncs from hostLogic)
            if (!fromHistory && !this.amIHost) {
                this.strokeHistory.push({ x1, y1, x2, y2, color, actionId, isEraser: isEraser });
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
                // Sync local history from hostLogic after undo
                this.strokeHistory = this.hostLogic.state.stroke_history || [];
                // Redraw canvas with updated history
                this.redrawFromHistory(this.strokeHistory);
            } else {
                this.socket.send(JSON.stringify({ type: "UNDO_STROKE", payload: {} }));
            }
        },
        setBrushColor(c) { 
            this.currentBrushColor = c; 
            this.isEraser = false;
        },
        toggleEraser() {
            this.isEraser = !this.isEraser;
        },
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
            // Clear canvas only, don't clear history (we're restoring it)
            if (this.ctx) {
                this.ctx.clearRect(0, 0, 2000, 1500);
            }
            if (!hist) return;
            // Draw all strokes from history
            hist.forEach(s => this.drawStroke(s.x1, s.y1, s.x2, s.y2, s.color, true));
        },
        startResultsAnimation() {
            this.animatedResults = [];
            const results = this.gameStateData.turn_results || {};
            let updateList = [];

            // Get all players (excluding host if spectator mode)
            const allPlayers = this.players.filter(p => {
                if (p.is_host && this.gameConfig.host_role === 'spectator') return false;
                return true;
            });

            // Create entries for all players
            allPlayers.forEach(player => {
                const res = results[player.nickname];
                updateList.push({
                    nickname: player.nickname,
                    points: res ? res.points : 0,
                    time: res ? res.time : null,
                    totalScore: player.score || 0 // Use current total score for sorting
                });
            });

            // Sort: Highest total score first, then by nickname for consistency
            updateList.sort((a, b) => {
                if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
                return a.nickname.localeCompare(b.nickname);
            });

            this.animatedResults = updateList;
        },
        checkResultsListScroll() {
            // Check if the results list container needs scrolling
            this.$nextTick(() => {
                const container = document.querySelector('.results-list-container');
                if (container) {
                    // Check if content height exceeds container height
                    this.resultsListNeedsScroll = container.scrollHeight > container.clientHeight;
                } else {
                    this.resultsListNeedsScroll = false;
                }
            });
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

