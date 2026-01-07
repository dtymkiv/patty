
// Game Host Logic
// Manages the authoritative game state and rules when the client is the Host.

class GameHost {
    constructor(broadcastFn, sendToFn, roomCode) {
        this.broadcast = broadcastFn; // (type, payload)
        this.sendTo = sendToFn;       // (targetClientId, type, payload)
        this.roomCode = roomCode;


        this.state = {
            round: 0,
            drawer: null,
            word: null,
            timer_end: 0,
            phase: "LOBBY", // LOBBY, DRAWER_PREPARING, DRAWING, POST_ROUND, GAME_OVER
            word_hints: "",
            correct_guessers: [],
            first_guess_time_left: 0,
            first_guesser_nickname: null,
            last_drawer: null,
            last_word: null,
            turn_results: {},
            stroke_history: [],
            used_words: new Set(),
            turn_queue: []
        };

        this.config = {
            round_duration: 60,
            points_to_win: 50,
            base_points: 10,
            turn_order: "sequence",
            host_role: "player", // 'player' or 'spectator'
            word_language: "English",
            word_difficulty: "Easy"
        };

        this.players = {}; // nickname -> { connected, score, color, is_ready, avatar... }
        this.wordSets = {}; // Loaded from external

        this.timerInterval = null;
        
        // Available colors for players
        this.availableColors = [
            '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8',
            '#F7DC6F', '#BB8FCE', '#85C1E2', '#F8B739', '#52BE80',
            '#E74C3C', '#3498DB', '#9B59B6', '#1ABC9C', '#F39C12',
            '#E67E22', '#34495E', '#16A085', '#27AE60', '#2980B9'
        ];
        this.usedColors = new Set();
    }

    // --- Initialization ---

    init(wordSets) {
        this.wordSets = wordSets;
    }

    setConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        this.broadcast("CONFIG_UPDATE", { config: this.config });
        this.saveState();
    }

    // --- Game Flow ---

    startGame() {
        if (this.state.phase !== "LOBBY") return;

        // Check if word sets are properly loaded
        if (!this.wordSets || Object.keys(this.wordSets).length === 0) {
            console.error("Cannot start game: Word sets not loaded");
            this.broadcast("ERROR", { message: "Word sets failed to load. Cannot start game." });
            return;
        }

        // Validate minimum players: need 2 active players
        // (If host is spectator, need 2 non-host players; if host is player, need host + 1 other)
        const activePlayers = Object.keys(this.players).filter(nick => {
            const p = this.players[nick];
            if (!p.connected) return false;
            if (p.is_host && this.config.host_role === 'spectator') return false;
            return true;
        });

        if (activePlayers.length < 2) {
            console.error("Cannot start game: Need at least 2 active players");
            this.broadcast("ERROR", { message: "Need at least 2 players to start the game." });
            return;
        }

        this.state.phase = "PRE_ROUND";
        this.state.round = 0;

        // Reset Scores
        Object.values(this.players).forEach(p => p.score = 0);

        // Start Loop
        this.nextTurn();
    }

    async nextTurn() {
        // Win Check
        if (this.state.round > 0) {
            const winners = Object.values(this.players).filter(p => p.score >= this.config.points_to_win);
            if (winners.length > 0) {
                this.endGame();
                return;
            }
        }

        // Queue Management
        if (this.state.turn_queue.length === 0) {
            this.refillTurnQueue();
        }

        if (this.state.turn_queue.length === 0) {
            // No players?
            this.endGame();
            return;
        }

        this.state.round++;
        const drawer = this.state.turn_queue.shift();
        this.state.drawer = drawer;

        // Word Selection
        try {
            this.selectWord();
        } catch (error) {
            console.error("Failed to select word:", error);
            this.broadcast("ERROR", { message: error.message });
            this.endGame();
            return;
        }

        // Phase Update
        this.state.phase = "DRAWER_PREPARING";
        this.state.timer_end = 0;
        this.state.correct_guessers = [];
        this.state.first_guess_time_left = 0;
        this.state.stroke_history = [];
        // this.state.turn_results = {}; // Defer clear to startActiveRound so UI can show results

        this.broadcastState();
    }

    refillTurnQueue() {
        const candidates = Object.keys(this.players).filter(nick => {
            const p = this.players[nick];
            if (!p.connected) return false;
            // Host role check - exclude host if spectator
            if (p.is_host && this.config.host_role === 'spectator') return false;
            return true;
        });

        // Shuffle
        for (let i = candidates.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
        }

        this.state.turn_queue = candidates;
    }

    selectWord() {
        const lang = this.config.word_language;
        const diff = this.config.word_difficulty;

        let words = [];
        if (this.wordSets[lang] && this.wordSets[lang][diff]) {
            words = this.wordSets[lang][diff];
        } else {
            // No fallback - word sets must be properly loaded
            console.error(`Word set not available for language: "${lang}", difficulty: "${diff}"`);
            throw new Error(`Cannot start game: Word set not found for ${lang} - ${diff}`);
        }

        // Filter used
        const available = words.filter(w => !this.state.used_words.has(w));

        let word;
        if (available.length === 0) {
            this.state.used_words.clear();
            word = words[Math.floor(Math.random() * words.length)];
        } else {
            word = available[Math.floor(Math.random() * available.length)];
        }

        this.state.used_words.add(word);
        this.state.word = word;
        this.state.word_hints = word.split('').map(c => c === ' ' ? ' ' : '_').join('');
    }

    startActiveRound() {
        if (this.state.phase !== "DRAWER_PREPARING") return;

        this.state.phase = "DRAWING";
        this.state.turn_results = {}; // Clear results now that new round starts
        const now = Date.now() / 1000;
        this.state.timer_end = now + this.config.round_duration;

        this.broadcastState();

        // Start Timer Interval
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
        // Check timer immediately, then set up interval with more frequent checks
        // Use 100ms interval for more reliable expiration detection
        this.checkTimer();
        this.timerInterval = setInterval(() => {
            this.checkTimer();
        }, 100);
    }

    checkTimer() {
        if (this.state.phase !== "DRAWING") {
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }
            return;
        }

        // Safety check: ensure timer_end is valid
        if (!this.state.timer_end || this.state.timer_end <= 0) {
            return;
        }

        const now = Date.now() / 1000;
        if (now >= this.state.timer_end) {
            // Timer expired - end the round
            if (this.timerInterval) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }
            // Use setTimeout to ensure endRound runs even if called from interval
            setTimeout(() => {
                // Double-check phase hasn't changed
                if (this.state.phase === "DRAWING" && now >= this.state.timer_end) {
                    this.endRound();
                }
            }, 0);
        }
    }

    endRound() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }

        // state.phase = "POST_ROUND"; // Removed
        this.state.last_drawer = this.state.drawer;
        this.state.last_word = this.state.word;

        // Apply scores
        Object.entries(this.state.turn_results).forEach(([nick, res]) => {
            if (this.players[nick]) {
                this.players[nick].score += res.points;
            }
        });

        // this.broadcastState(); // nextTurn will broadcast

        // Immediately start next turn (DRAWER_PREPARING)
        this.nextTurn();
    }

    endGame() {
        this.state.phase = "GAME_OVER";
        this.broadcastState();
    }

    resetToLobby() {
        // Reset game state back to lobby while preserving config and players
        this.state.phase = "LOBBY";
        this.state.round = 0;
        this.state.drawer = null;
        this.state.last_drawer = null;
        this.state.last_word = null;
        this.state.word = null;
        this.state.word_hints = null;
        this.state.timer_end = 0;
        this.state.time_left = 0;
        this.state.correct_guessers = [];
        this.state.turn_results = {};
        this.state.stroke_history = [];
        
        // Reset all player scores
        Object.values(this.players).forEach(p => {
            p.score = 0;
            p.is_ready = false;
            p.has_guessed_correctly = false;
        });
        
        this.broadcastState();
    }

    // --- Handlers ---

    handleChat(senderNickname, text) {
        const sender = this.players[senderNickname];
        
        // If host is spectator, they can only chat, not guess
        if (sender && sender.is_host && this.config.host_role === 'spectator') {
            this.broadcast("CHAT", { sender: senderNickname, text: text, color: sender.color });
            return;
        }
        
        if (this.state.phase !== "DRAWING") {
            // Just chat
            this.broadcast("CHAT", { sender: senderNickname, text: text, color: this.players[senderNickname]?.color });
            return;
        }

        // Game Logic Check
        if (senderNickname === this.state.drawer) return; // Drawer can't guess
        if (this.state.correct_guessers.includes(senderNickname)) {
            // Already guessed, maybe relay as hidden/system? Or allow chat?
            // Usually we filter spoilery messages.
            // For now, just broadcast.
            this.broadcast("CHAT", { sender: senderNickname, text: text, color: this.players[senderNickname]?.color });
            return;
        }

        const cleanText = this.normalizeWord(text);
        const targetWord = this.normalizeWord(this.state.word);

        if (cleanText === targetWord) {
            // CORRECT!
            this.processCorrectGuess(senderNickname);
        } else {
            // WRONG - Mask for spoilers
            this.broadcast("CHAT", { sender: senderNickname, text: "guessed incorrectly", color: this.players[senderNickname]?.color });
        }
    }

    processCorrectGuess(nickname) {
        const now = Date.now() / 1000;
        const timeLeft = Math.max(0, this.state.timer_end - now);
        const duration = this.config.round_duration;

        const isFirst = this.state.correct_guessers.length === 0;
        let points = 0;

        if (isFirst) {
            this.state.first_guess_time_left = timeLeft;
            this.state.first_guesser_nickname = nickname;
            points = this.config.base_points;

            // Drawer Points
            const drawerPoints = Math.min(this.config.base_points, Math.round((timeLeft / (duration * 0.75)) * this.config.base_points));
            this.state.turn_results[this.state.drawer] = { points: drawerPoints, time: Math.round(duration - timeLeft) };
        } else {
            const tFirst = this.state.first_guess_time_left;
            if (tFirst > 0) {
                points = Math.round((timeLeft / tFirst) * this.config.base_points);
            }
        }

        const timeTaken = Math.round(duration - timeLeft);
        this.state.turn_results[nickname] = { points: points, time: timeTaken };
        this.state.correct_guessers.push(nickname);

        // Notify
        this.broadcast("CHAT", { sender: "System", text: `${nickname} guessed correctly!`, color: "#10B981" });
        this.broadcastState(); // Updates scores/correct list

        // Check if all guessed
        const activeGuessers = Object.entries(this.players).filter(([nick, p]) => {
            if (!p.connected) return false;
            if (nick === this.state.drawer) return false;
            if (p.is_host && this.config.host_role === 'spectator') return false;
            return true;
        }).length;
        if (this.state.correct_guessers.length >= activeGuessers) {
            this.endRound();
        }
    }

    handleDraw(stroke) {
        this.state.stroke_history.push(stroke);
        this.broadcast("DRAW_STROKE", stroke);
        // Save state on every stroke to ensure reconnection has latest strokes
        this.saveState();
    }

    handleUndo() {
        if (this.state.stroke_history.length === 0) return;

        // Get the last stroke's actionId
        const lastStroke = this.state.stroke_history[this.state.stroke_history.length - 1];
        const actionId = lastStroke.actionId;

        if (actionId) {
            // Remove all strokes with this actionId (undo entire click-to-release)
            this.state.stroke_history = this.state.stroke_history.filter(s => s.actionId !== actionId);
        } else {
            // Fallback to single stroke undo for old format
            this.state.stroke_history.pop();
        }

        this.broadcast("STROKE_HISTORY_UPDATE", { history: this.state.stroke_history });
        this.saveState();
    }

    handleClear() {
        this.state.stroke_history = [];
        this.broadcast("CLEAR_CANVAS", {});
        this.saveState();
    }

    handleToggleReady(nickname) {
        if (this.players[nickname]) {
            this.players[nickname].is_ready = !this.players[nickname].is_ready;
            this.broadcastState();
        }
    }
    
    addPlayer(nickname, isHost = false) {
        if (!this.players[nickname]) {
            this.players[nickname] = {
                connected: true,
                score: 0,
                is_ready: false,
                is_host: isHost,
                clientId: nickname
            };
            // Assign color when player is added
            this.assignColor(nickname);
        }
    }
    
    removePlayer(nickname) {
        if (this.players[nickname]) {
            this.releaseColor(nickname);
            delete this.players[nickname];
        }
    }

    // --- Utils ---

    normalizeWord(text) {
        // Convert to lowercase
        let normalized = text.toLowerCase().trim();

        // Normalize Unicode (decompose accented characters)
        normalized = normalized.normalize('NFD');

        // Remove diacritics (accents, umlauts, etc.)
        normalized = normalized.replace(/[\u0300-\u036f]/g, '');

        // Normalize common ligatures
        normalized = normalized
            .replace(/æ/g, 'ae')
            .replace(/œ/g, 'oe')
            .replace(/ð/g, 'd')
            .replace(/þ/g, 'th')
            .replace(/ß/g, 'ss');

        // Normalize apostrophes and quotes (all variants → standard apostrophe)
        normalized = normalized
            .replace(/[\u0027\u0060\u00B4\u2018\u2019\u02BC\u2032]/g, "'");

        // Normalize quotes (various types → standard double quote)
        normalized = normalized
            .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"');

        // Normalize hyphens and dashes (various types → standard hyphen)
        normalized = normalized
            .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015]/g, '-');

        // Normalize whitespace (multiple spaces → single space)
        normalized = normalized.replace(/\s+/g, ' ').trim();

        return normalized;
    }

    broadcastState() {
        // We need to create a "Public" state view (hide word from guessers)
        // But since we broadcast to ALL, we must send the censored version.
        // Drawer needs the real word.
        // So we might need to send individual messages?
        // OR we send the word, but the Client UI hides it if not drawer.
        // SECURITY RISK: Cheating.
        // Ideally, send specific messages. 
        // `broadcast` sends to everyone.
        // `sendTo` sends to specific.

        // 1. Broadcast Public State
        const publicState = { 
            ...this.state, 
            word: null,
            // Explicitly include stroke_history for reconnection scenarios
            stroke_history: this.state.stroke_history || []
        };
        if (this.state.phase === "GAME_OVER" || this.state.phase === "POST_ROUND") {
            publicState.word = this.state.word; // Reveal at end
        }

        this.broadcast("GAME_STATE_UPDATE", {
            game_state: publicState,
            scores: this.getScores(),
            players: this.getPlayersList(),
            config: this.config
        });

        this.saveState();
        
        // Ensure timer is running if we're in DRAWING phase
        // This acts as a backup check in case the interval was cleared
        if (this.state.phase === "DRAWING" && this.state.timer_end > 0) {
            const now = Date.now() / 1000;
            if (now >= this.state.timer_end) {
                // Timer expired, end round immediately
                if (this.timerInterval) {
                    clearInterval(this.timerInterval);
                    this.timerInterval = null;
                }
                // End round immediately - don't defer
                this.endRound();
                return; // Don't continue after ending round
            } else if (!this.timerInterval) {
                // Timer should be running but isn't - restart it
                // Use 100ms interval for more reliable expiration detection
                this.timerInterval = setInterval(() => {
                    if (this.state.phase === "DRAWING" && this.state.timer_end > 0) {
                        this.checkTimer();
                    } else {
                        if (this.timerInterval) {
                            clearInterval(this.timerInterval);
                            this.timerInterval = null;
                        }
                    }
                }, 100);
            }
        }

        // 2. Send Secret Word to Drawer
        const drawerId = this.findClientIdByNickname(this.state.drawer); // We need a way to map Nick -> ClientID?
        // Actually, we don't know ClientIDs easily here unless we track them.
        // We only have Nicknames in `this.players`.
        // We rely on the App to facilitate this routing or we send "DRAWER_INFO" to everyone but only drawer reads it? No used network panel to cheat.

        // Solution: The Host *is* a client. The Host can just "sendTo" if they know the ID.
        // The `players` object should track `clientId`.
        if (this.state.drawer && (this.state.phase === "DRAWING" || this.state.phase === "DRAWER_PREPARING")) {
            // Find drawer client ID
            const drawerData = this.players[this.state.drawer];
            // If drawer is Host (Me), I already know.
            // If drawer is other, send message.
            if (drawerData && drawerData.clientId) {
                this.sendTo(drawerData.clientId, "DRAWER_SECRET", { word: this.state.word });
            }
        }
    }

    getScores() {
        const s = {};
        Object.entries(this.players).forEach(([n, p]) => s[n] = p.score);
        return s;
    }

    assignColor(nickname) {
        // If player already has a color, keep it
        if (this.players[nickname] && this.players[nickname].color) {
            return this.players[nickname].color;
        }
        
        // Find an unused color
        for (const color of this.availableColors) {
            if (!this.usedColors.has(color)) {
                this.usedColors.add(color);
                if (!this.players[nickname]) {
                    this.players[nickname] = {};
                }
                this.players[nickname].color = color;
                return color;
            }
        }
        
        // If all colors are used, generate a random one
        const randomColor = '#' + Math.floor(Math.random()*16777215).toString(16);
        if (!this.players[nickname]) {
            this.players[nickname] = {};
        }
        this.players[nickname].color = randomColor;
        return randomColor;
    }
    
    releaseColor(nickname) {
        if (this.players[nickname] && this.players[nickname].color) {
            const color = this.players[nickname].color;
            if (this.availableColors.includes(color)) {
                this.usedColors.delete(color);
            }
        }
    }

    getPlayersList() {
        return Object.entries(this.players).map(([nick, p]) => ({
            nickname: nick,
            score: p.score,
            connected: p.connected,
            is_ready: p.is_ready,
            is_host: p.is_host,
            color: p.color || '#ea5128',
            has_guessed_correctly: this.state.correct_guessers.includes(nick),
            is_spectator: p.is_host && this.config.host_role === 'spectator'
        }));
    }

    findClientIdByNickname(nick) {
        return this.players[nick]?.clientId;
    }

    // --- Persistence ---

    saveState() {
        if (!this.roomCode) return;
        const data = {
            players: this.players,
            state: { ...this.state, used_words: Array.from(this.state.used_words) },
            config: this.config
        };
        localStorage.setItem(`host_state_${this.roomCode}`, JSON.stringify(data));
    }

    loadState() {
        if (!this.roomCode) return false;
        const saved = localStorage.getItem(`host_state_${this.roomCode}`);
        if (!saved) return false;
        try {
            const data = JSON.parse(saved);
            this.players = data.players || {};
            this.state = { ...this.state, ...data.state };
            this.state.used_words = new Set(data.state?.used_words || []);
            // Ensure stroke_history is an array
            if (!Array.isArray(this.state.stroke_history)) {
                this.state.stroke_history = [];
            }
            this.config = data.config || this.config;
            
            // Restore used colors from saved players
            this.usedColors.clear();
            Object.values(this.players).forEach(p => {
                if (p.color && this.availableColors.includes(p.color)) {
                    this.usedColors.add(p.color);
                }
            });
            
            // Restore timer if game is in DRAWING phase
            if (this.state.phase === "DRAWING" && this.state.timer_end > 0) {
                // Clear any existing timer
                if (this.timerInterval) {
                    clearInterval(this.timerInterval);
                    this.timerInterval = null;
                }
                
                // Check if timer has already expired
                const now = Date.now() / 1000;
                if (now >= this.state.timer_end) {
                    // Timer expired while host was disconnected - end round immediately
                    // Use setTimeout to ensure state is fully restored before ending round
                    setTimeout(() => {
                        this.endRound();
                    }, 100);
                } else {
                    // Restart timer interval - use arrow function to preserve 'this'
                    this.timerInterval = setInterval(() => {
                        if (this.state.phase === "DRAWING" && this.state.timer_end > 0) {
                            this.checkTimer();
                        } else {
                            // Phase changed or timer_end invalid, clear interval
                            if (this.timerInterval) {
                                clearInterval(this.timerInterval);
                                this.timerInterval = null;
                            }
                        }
                    }, 1000);
                }
            }
            
            return true;
        } catch (e) {
            console.error("Failed to load host state", e);
            return false;
        }
    }
}
