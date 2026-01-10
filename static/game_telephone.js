// Telephone Game Host Logic (Gartic Phone style)
// Chain-based drawing/guessing game where content passes through all players

class TelephoneHost {
    constructor(broadcastFn, sendToFn, roomCode) {
        this.broadcast = broadcastFn;
        this.sendTo = sendToFn;
        this.roomCode = roomCode;

        this.state = {
            phase: "LOBBY", // LOBBY, TEXT_INPUT, DRAWING, GUESSING, RESULTS, GAME_OVER
            round: 0,
            maxRounds: 0, // Set based on player count or config
            timer_end: 0,
            chains: {}, // chainId -> { steps: [{type, content, author}], currentHolder }
            submissions: {}, // nickname -> submitted content for current phase
            currentStep: 0, // Which step in the chain we're on (0 = initial text)
            strokeHistories: {}, // nickname -> stroke array for current drawing phase
            rotation: [], // Chain rotation mapping
            activePlayers: [], // Active players list
            currentAssignments: {} // nickname -> { chainId, textToDraw/drawingToGuess }
        };

        this.config = {
            draw_duration: 90,
            guess_duration: 45,
            max_rounds: 0, // 0 = auto, otherwise specifies number of drawing rounds (capped at playerCount)
            host_role: "player",
        };

        this.players = {};
        this.timerInterval = null;
        
        this.availableColors = [
            '#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8',
            '#F7DC6F', '#BB8FCE', '#85C1E2', '#F8B739', '#52BE80',
            '#E74C3C', '#3498DB', '#9B59B6', '#1ABC9C', '#F39C12'
        ];
        this.usedColors = new Set();
    }

    init() {}

    setConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        this.broadcast("CONFIG_UPDATE", { config: this.config });
        this.saveState();
    }

    // Generate chain assignments using Latin Square-like permutation
    // Ensures no player gets their content back and chains rotate properly
    generateChainAssignments(players) {
        const n = players.length;
        if (n < 2) return null;

        // Create a derangement-based rotation pattern
        // Each player's chain will pass through all other players
        const assignments = {};
        
        for (let step = 0; step <= this.state.maxRounds; step++) {
            assignments[step] = {};
            for (let i = 0; i < n; i++) {
                // Each step, shift by (step) positions, ensuring derangement
                const targetIdx = (i + step) % n;
                // Chain i is held by player at targetIdx
                assignments[step][players[i]] = players[targetIdx];
            }
        }
        
        return assignments;
    }

    // Get who holds which chain at each step - creates proper derangement
    createChainRotation(players) {
        const n = players.length;
        const rotation = [];
        
        // For each step, create mapping: chainOwner -> currentHolder
        for (let step = 0; step <= this.state.maxRounds; step++) {
            const stepMap = {};
            for (let i = 0; i < n; i++) {
                const chainOwner = players[i];
                // Shift by step positions (derangement for step > 0)
                const holderIdx = (i + step) % n;
                stepMap[chainOwner] = players[holderIdx];
            }
            rotation.push(stepMap);
        }
        
        return rotation;
    }

    startGame() {
        if (this.state.phase !== "LOBBY") return;

        const activePlayers = Object.keys(this.players).filter(nick => {
            const p = this.players[nick];
            if (!p.connected) return false;
            if (p.is_host && this.config.host_role === 'spectator') return false;
            return true;
        });

        if (activePlayers.length < 3) {
            this.broadcast("ERROR", { message: "Need at least 3 players for Telephone." });
            return;
        }

        // config.max_rounds represents number of DRAWING rounds
        // Determine actual drawing rounds (0 = auto, capped at playerCount)
        const drawingRounds = this.config.max_rounds > 0 
            ? Math.min(this.config.max_rounds, activePlayers.length)
            : activePlayers.length;
        
        // Convert drawing rounds to total steps: (drawingRounds * 2) - 1
        // Example: 2 drawing rounds = init -> draw1 -> guess1 -> draw2 = 3 steps
        this.state.maxRounds = (drawingRounds * 2) - 1;

        // Initialize chains - each player starts their own chain
        this.state.chains = {};
        for (const nick of activePlayers) {
            this.state.chains[nick] = {
                steps: [],
                originalAuthor: nick
            };
        }

        // Create rotation pattern
        this.state.rotation = this.createChainRotation(activePlayers);
        this.state.activePlayers = activePlayers;
        this.state.currentStep = 0;
        this.state.round = 1;

        // Start with text input phase
        this.startTextInputPhase();
    }

    startTextInputPhase() {
        this.state.phase = "TEXT_INPUT";
        this.state.submissions = {};
        this.state.timer_end = 0; // No timer for initial text input

        this.broadcastState();
        // No timer - wait for all players to submit
    }

    endTextInputPhase() {
        this.clearTimer();

        // For players who didn't submit, use placeholder
        for (const nick of this.state.activePlayers) {
            if (!this.state.submissions[nick]) {
                this.state.submissions[nick] = "(no text entered)";
            }
            // Add to their own chain
            this.state.chains[nick].steps.push({
                type: 'text',
                content: this.state.submissions[nick],
                author: nick
            });
        }

        this.state.currentStep = 1;
        this.startDrawingPhase();
    }

    startDrawingPhase(isRestoration = false) {
        this.state.phase = "DRAWING";
        this.state.submissions = {};
        // Clear stroke histories for new rounds, preserve only during restoration
        if (!isRestoration) {
            this.state.strokeHistories = {};
            this.state.timer_end = Date.now() / 1000 + this.config.draw_duration;
        }

        this.broadcastState();
        this.sendDrawingAssignments();
        this.startTimer(() => this.endDrawingPhase());
    }

    sendDrawingAssignments() {
        // Each player gets the last content from the chain they're assigned to
        const currentRotation = this.state.rotation[this.state.currentStep];
        this.state.currentAssignments = {};
        
        for (const chainOwner in currentRotation) {
            const holder = currentRotation[chainOwner];
            const chain = this.state.chains[chainOwner];
            const lastStep = chain.steps[chain.steps.length - 1];
            // Fallback if the last guess was empty: use the most recent meaningful text
            let textContent = lastStep.content;
            if (!this.isMeaningfulText(textContent)) {
                const fallback = this.findLastMeaningfulStep(chain, 'text');
                if (fallback !== null) {
                    textContent = fallback;
                } else {
                    // As a final fallback, use the chain's initial phrase if available
                    textContent = chain.steps[0]?.content || "(no text entered)";
                }
            }
            
            // Store assignment for reconnection
            this.state.currentAssignments[holder] = {
                chainId: chainOwner,
                textToDraw: textContent,
                stepNumber: this.state.currentStep
            };
            
            // Send the text/guess to draw to the current holder
            this.sendTo(holder, "DRAW_ASSIGNMENT", this.state.currentAssignments[holder]);
        }
        this.saveState();
    }

    endDrawingPhase() {
        this.clearTimer();

        const currentRotation = this.state.rotation[this.state.currentStep];
        
        // Save drawings to chains
        for (const chainOwner in currentRotation) {
            const holder = currentRotation[chainOwner];
            const drawing = this.state.strokeHistories[holder] || [];
            
            this.state.chains[chainOwner].steps.push({
                type: 'drawing',
                content: drawing,
                author: holder
            });
        }

        this.state.currentStep++;
        
        // Check if we should continue or end game
        if (this.state.currentStep > this.state.maxRounds) {
            this.showResults();
        } else {
            this.startGuessingPhase();
        }
    }

    startGuessingPhase() {
        this.state.phase = "GUESSING";
        this.state.submissions = {};
        // Clear stroke histories from drawing phase (drawings are now in chains)
        this.state.strokeHistories = {};
        this.state.timer_end = Date.now() / 1000 + this.config.guess_duration;

        this.broadcastState();
        this.sendGuessingAssignments();
        this.startTimer(() => this.endGuessingPhase());
    }

    sendGuessingAssignments() {
        const currentRotation = this.state.rotation[this.state.currentStep];
        this.state.currentAssignments = {};
        
        for (const chainOwner in currentRotation) {
            const holder = currentRotation[chainOwner];
            const chain = this.state.chains[chainOwner];
            const lastStep = chain.steps[chain.steps.length - 1];
            // Fallback if drawing is empty: use the most recent non-empty drawing
            let drawingContent = lastStep.content;
            if (!this.isMeaningfulDrawing(drawingContent)) {
                const fallbackDrawing = this.findLastMeaningfulStep(chain, 'drawing');
                if (fallbackDrawing !== null) {
                    drawingContent = fallbackDrawing;
                } else {
                    // No drawing exists, use empty array (empty canvas)
                    drawingContent = [];
                }
            }
            
            // Store assignment for reconnection
            this.state.currentAssignments[holder] = {
                chainId: chainOwner,
                drawingToGuess: drawingContent,
                stepNumber: this.state.currentStep
            };
            
            // Send the drawing to guess
            this.sendTo(holder, "GUESS_ASSIGNMENT", this.state.currentAssignments[holder]);
        }
        this.saveState();
    }

    endGuessingPhase() {
        this.clearTimer();

        const currentRotation = this.state.rotation[this.state.currentStep];
        
        // Save guesses to chains
        for (const chainOwner in currentRotation) {
            const holder = currentRotation[chainOwner];
            const guess = this.state.submissions[holder] || "(no guess)";
            let guessContent = guess;
            if (!this.isMeaningfulText(guessContent)) {
                // Fallback to latest meaningful text in the chain, otherwise initial phrase
                const chain = this.state.chains[chainOwner];
                const fallbackText = this.findLastMeaningfulStep(chain, 'text');
                guessContent = fallbackText !== null ? fallbackText : (chain.steps[0]?.content || "(no text entered)");
            }
            
            this.state.chains[chainOwner].steps.push({
                type: 'text',
                content: guessContent,
                author: holder
            });
        }

        this.state.currentStep++;
        this.state.round++;

        // Check if we should continue or end game
        if (this.state.currentStep > this.state.maxRounds) {
            this.showResults();
        } else {
            // Alternate between drawing and guessing
            if (this.state.currentStep % 2 === 1) {
                this.startDrawingPhase();
            } else {
                this.startGuessingPhase();
            }
        }
    }

    showResults() {
        this.state.phase = "RESULTS";
        this.state.currentChainIndex = 0;
        this.state.currentStepInChain = 0;
        this.broadcastState();
    }

    nextResultStep() {
        const chainKeys = Object.keys(this.state.chains);
        const currentChain = this.state.chains[chainKeys[this.state.currentChainIndex]];
        
        if (this.state.currentStepInChain < currentChain.steps.length - 1) {
            this.state.currentStepInChain++;
        } else if (this.state.currentChainIndex < chainKeys.length - 1) {
            this.state.currentChainIndex++;
            this.state.currentStepInChain = 0;
        } else {
            this.endGame();
            return;
        }
        
        this.broadcastState();
    }

    endGame() {
        this.state.phase = "GAME_OVER";
        this.broadcastState();
    }

    resetToLobby() {
        this.state = {
            phase: "LOBBY",
            round: 0,
            maxRounds: 0,
            timer_end: 0,
            chains: {},
            submissions: {},
            currentStep: 0,
        };
        
        Object.values(this.players).forEach(p => {
            p.is_ready = false;
        });
        
        this.broadcastState();
    }

    // Handlers
    handleTextSubmission(nickname, text) {
        if (this.state.phase !== "TEXT_INPUT") return;
        this.state.submissions[nickname] = text.trim() || "(empty)";
        this.broadcastState(); // Broadcast immediately so UI updates
        this.checkAllSubmitted();
    }

    handleGuessSubmission(nickname, guess) {
        if (this.state.phase !== "GUESSING") return;
        this.state.submissions[nickname] = guess.trim() || "(empty)";
        this.broadcastState(); // Broadcast immediately so UI updates
        this.checkAllSubmitted();
    }

    handleDrawStroke(nickname, stroke) {
        if (this.state.phase !== "DRAWING") return;
        
        if (!this.state.strokeHistories[nickname]) {
            this.state.strokeHistories[nickname] = [];
        }
        this.state.strokeHistories[nickname].push(stroke);
        this.saveState();
    }

    // Full stroke history sync (called on mouseup for reliability)
    syncStrokeHistory(nickname, history) {
        if (this.state.phase !== "DRAWING") return;
        if (!Array.isArray(history)) return;
        
        // Only update if the incoming history is at least as long as what we have
        // (player might have more strokes than we received individually)
        const currentLength = (this.state.strokeHistories[nickname] || []).length;
        if (history.length >= currentLength) {
            this.state.strokeHistories[nickname] = [...history];
            this.saveState();
        }
    }

    handleClearCanvas(nickname) {
        if (this.state.phase !== "DRAWING") return;
        this.state.strokeHistories[nickname] = [];
        this.saveState();
    }

    handleUndo(nickname) {
        if (this.state.phase !== "DRAWING") return;
        if (!this.state.strokeHistories[nickname]) return;
        
        const history = this.state.strokeHistories[nickname];
        if (history.length === 0) return;
        
        const lastStroke = history[history.length - 1];
        const actionId = lastStroke.actionId;
        
        if (actionId) {
            this.state.strokeHistories[nickname] = history.filter(s => s.actionId !== actionId);
        } else {
            history.pop();
        }
        
        // Send updated history back to player
        this.sendTo(nickname, "STROKE_HISTORY_UPDATE", { 
            history: this.state.strokeHistories[nickname] 
        });
        this.saveState();
    }

    handleToggleReady(nickname) {
        if (this.players[nickname]) {
            this.players[nickname].is_ready = !this.players[nickname].is_ready;
            this.broadcastState();
        }
    }

    checkAllSubmitted() {
        const expected = this.state.activePlayers.length;
        const submitted = Object.keys(this.state.submissions).length;
        
        if (submitted >= expected) {
            // All submitted, skip timer
            if (this.state.phase === "TEXT_INPUT") {
                this.endTextInputPhase();
            } else if (this.state.phase === "GUESSING") {
                this.endGuessingPhase();
            }
        }
    }

    handleChat(senderNickname, text) {
        this.broadcast("CHAT", { 
            sender: senderNickname, 
            text: text, 
            color: this.players[senderNickname]?.color 
        });
    }

    addPlayer(nickname, isHost = false) {
        if (!this.players[nickname]) {
            this.players[nickname] = {
                connected: true,
                is_ready: false,
                is_host: isHost,
                clientId: nickname
            };
            this.assignColor(nickname);
        }
    }

    removePlayer(nickname) {
        if (this.players[nickname]) {
            this.releaseColor(nickname);
            delete this.players[nickname];
        }
    }

    // Timer utilities
    startTimer(callback) {
        this.clearTimer();
        this.timerInterval = setInterval(() => {
            const now = Date.now() / 1000;
            if (now >= this.state.timer_end) {
                callback();
            }
        }, 100);
    }

    clearTimer() {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }

    // Color management
    assignColor(nickname) {
        if (this.players[nickname]?.color) return this.players[nickname].color;
        
        for (const color of this.availableColors) {
            if (!this.usedColors.has(color)) {
                this.usedColors.add(color);
                if (!this.players[nickname]) this.players[nickname] = {};
                this.players[nickname].color = color;
                return color;
            }
        }
        
        const randomColor = '#' + Math.floor(Math.random()*16777215).toString(16);
        if (!this.players[nickname]) this.players[nickname] = {};
        this.players[nickname].color = randomColor;
        return randomColor;
    }

    releaseColor(nickname) {
        if (this.players[nickname]?.color) {
            const color = this.players[nickname].color;
            if (this.availableColors.includes(color)) {
                this.usedColors.delete(color);
            }
        }
    }

    getPlayersList() {
        return Object.entries(this.players).map(([nick, p]) => ({
            nickname: nick,
            connected: p.connected,
            is_ready: p.is_ready,
            is_host: p.is_host,
            color: p.color || '#ea5128',
            is_spectator: p.is_host && this.config.host_role === 'spectator',
            hasSubmitted: !!this.state.submissions?.[nick]
        }));
    }

    broadcastState() {
        const publicState = {
            ...this.state,
            chains: this.state.phase === "RESULTS" || this.state.phase === "GAME_OVER" 
                ? this.state.chains 
                : undefined, // Only reveal chains in results
            // Include strokeHistories for host reconnection
            strokeHistories: this.state.strokeHistories || {},
            currentAssignments: this.state.currentAssignments || {}
        };

        this.broadcast("GAME_STATE_UPDATE", {
            game_state: publicState,
            players: this.getPlayersList(),
            config: this.config,
            gameType: 'telephone'
        });

        this.saveState();
    }

    saveState() {
        if (!this.roomCode) return;
        const data = {
            players: this.players,
            state: this.state,
            config: this.config,
            gameType: 'telephone'
        };
        localStorage.setItem(`telephone_state_${this.roomCode}`, JSON.stringify(data));
    }

    loadState() {
        if (!this.roomCode) return false;
        const saved = localStorage.getItem(`telephone_state_${this.roomCode}`);
        if (!saved) return false;
        try {
            const data = JSON.parse(saved);
            this.players = data.players || {};
            this.state = { ...this.state, ...data.state };
            this.config = data.config || this.config;
            
            this.usedColors.clear();
            Object.values(this.players).forEach(p => {
                if (p.color && this.availableColors.includes(p.color)) {
                    this.usedColors.add(p.color);
                }
            });
            
            // Restore timer if game is in active phase (but not for TEXT_INPUT which has no timer)
            if (this.state.phase !== "LOBBY" && this.state.phase !== "RESULTS" && this.state.phase !== "GAME_OVER" && this.state.phase !== "TEXT_INPUT") {
                const now = Date.now() / 1000;
                if (this.state.timer_end > now) {
                    // Timer still valid, restart it with correct callback
                    const endCallback = () => {
                        if (this.state.phase === "DRAWING") this.endDrawingPhase();
                        else if (this.state.phase === "GUESSING") this.endGuessingPhase();
                    };
                    this.startTimer(endCallback);
                } else {
                    // Timer expired while disconnected, end phase after broadcasting current state
                    setTimeout(() => {
                        if (this.state.phase === "DRAWING") this.endDrawingPhase();
                        else if (this.state.phase === "GUESSING") this.endGuessingPhase();
                    }, 500); // Delay to allow state broadcast first
                }
            }
            
            return true;
        } catch (e) {
            console.error("Failed to load telephone state", e);
            return false;
        }
    }

    // Resend assignments to all players (for reconnection)
    resendAssignments() {
        if (this.state.phase === "DRAWING") {
            for (const holder in this.state.currentAssignments) {
                this.resendAssignmentToPlayer(holder);
            }
        } else if (this.state.phase === "GUESSING") {
            for (const holder in this.state.currentAssignments) {
                this.resendAssignmentToPlayer(holder);
            }
        }
    }

    // Resend assignment to a specific player (for individual reconnection)
    resendAssignmentToPlayer(nickname) {
        const assignment = this.state.currentAssignments[nickname];
        if (!assignment) return;
        
        if (this.state.phase === "DRAWING" && assignment.textToDraw !== undefined) {
            // Include stroke history directly in the assignment for reconnection
            const assignmentWithHistory = {
                ...assignment,
                strokeHistory: this.state.strokeHistories[nickname] || []
            };
            this.sendTo(nickname, "DRAW_ASSIGNMENT", assignmentWithHistory);
        } else if (this.state.phase === "GUESSING" && assignment.drawingToGuess !== undefined) {
            this.sendTo(nickname, "GUESS_ASSIGNMENT", assignment);
        }
    }

    // Utility: find latest meaningful step content of a given type in a chain
    findLastMeaningfulStep(chain, type) {
        for (let i = chain.steps.length - 1; i >= 0; i--) {
            const step = chain.steps[i];
            if (step.type !== type) continue;
            if (type === 'drawing' && this.isMeaningfulDrawing(step.content)) {
                return step.content;
            }
            if (type === 'text' && this.isMeaningfulText(step.content)) {
                return step.content;
            }
        }
        return null;
    }

    isMeaningfulDrawing(content) {
        return Array.isArray(content) && content.length > 0;
    }

    isMeaningfulText(content) {
        if (!content || typeof content !== 'string') return false;
        const trimmed = content.trim();
        if (!trimmed) return false;
        // Treat placeholders as non-meaningful
        return trimmed !== "(no guess)" && trimmed !== "(no text entered)" && trimmed !== "(empty)";
    }
}
