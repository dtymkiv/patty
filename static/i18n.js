const translations = {
    en: {
        // Page title
        pageTitle: 'Party Games Service',

        // Login view
        enterNickname: 'Enter Nickname',
        nicknamePlaceholder: 'Your cool nickname...',
        generateRandom: 'Generate random name',
        enterLobby: 'Enter Lobby',

        // Lobby view
        joinWithCode: 'Join with Code',
        joinGame: 'JOIN GAME',
        hostGame: 'Host a Game',
        hostDescription: 'Start a new room and share the 6-digit code with your friends.',
        createNewGame: 'CREATE NEW GAME',

        // Header
        playingAs: 'Playing as:',
        switchToLight: 'Switch to Light Mode',
        switchToDark: 'Switch to Dark Mode',

        // Room navigation
        leave: 'Leave',
        code: 'Code',
        ready: 'Ready',
        unready: 'Unready',
        startGame: 'Start Game',
        live: 'Live!',

        // Settings
        settings: 'Settings',
        theme: 'Theme',
        hostRole: 'Host Role',
        player: 'Player',
        spectator: 'Spectator',
        roundDuration: 'Round Duration',
        pointsToWin: 'Points to Win',
        basePoints: 'Base Points (First Guess)',
        turnOrder: 'Turn Order',
        sequential: 'Sequential',
        winnerFirst: 'Who guessed first',
        language: 'Language',
        difficulty: 'Difficulty',
        onlyHostSettings: 'Only the host can change settings.',

        // Game area
        drawing: 'Drawing',
        startRound: 'START ROUND!',
        roundProcessing: 'Round processing...',

        // Chat & Players
        chat: 'Chat',
        players: 'Players',
        typeMessage: 'Type a message...',
        typeGuess: 'Type a guess...',
        guessedCorrectly: 'You guessed correctly!',
        send: 'Send',
        you: '(you)',
        drawer: '(Drawer)',

        // Host disconnected modal
        gamePaused: 'Game Paused',
        hostDisconnectedWaiting: 'The Host has disconnected. Waiting for them to reconnect...',

        // Game over modal
        gameOver: 'GAME OVER!',
        wordWas: 'The word was:',
        yourWord: 'Your word is',
        winner: 'Winner',
        leaderboard: 'Leaderboard',
        playAgain: 'Play Again',
        leaveRoom: 'Leave Room',

        // Results modal
        nextUp: 'Next Up:',
        wasDrawing: 'was drawing',
        waitFor: 'Wait for',
        total: 'Total:',
        guessedIn: 'Guessed in',

        // Invite modal
        inviteFriends: 'Invite Friends',
        shareLink: 'Share this link or QR code to invite players',
        copyLink: 'Copy Link',
        copied: '✓ Copied!',
        close: 'Close',

        // Leave modals
        endSession: 'End Session?',
        hostLeaveWarning: 'As the host, leaving will close this room for all players.',
        leaveCloseRoom: 'LEAVE & CLOSE ROOM',
        stayInGame: 'STAY IN GAME',
        leaveGame: 'Leave Game?',
        playerLeaveWarning: 'You will be unable to reconnect to this game once you leave. Are you sure?',
        leaveGameBtn: 'LEAVE GAME',

        // Notifications
        joined: 'joined',
        reconnected: 'reconnected',
        left: 'left',
        disconnected: 'Disconnected',
        hostDisconnected: 'Host disconnected',
        hostReconnected: 'Host reconnected',
        roomClosed: 'Room closed by host',
        failedToCreate: 'Failed to create room',
        failedToLoad: 'Failed to load word sets. Please refresh the page.',
        wordSetsLoading: 'Word sets are still loading. Please wait...',
        gameLogicNotInit: 'Game logic not initialized',

        // Random name generator
        adjectives: ['Happy', 'Silly', 'Brave', 'Clever', 'Swift', 'Mighty'],
        nouns: ['Panda', 'Tiger', 'Eagle', 'Fox', 'Wolf', 'Bear'],

        // Game types
        selectGame: 'Select Game',
        alligator: 'Alligator',
        alligatorDesc: 'Classic drawing game - guess what others draw!',
        telephone: 'Telephone',
        telephoneDesc: 'Write → Draw → Guess in a chain!',

        // Telephone game
        enterPhrase: 'Enter a phrase for others to draw',
        phrasePlaceholder: 'Type something fun...',
        submitPhrase: 'Submit',
        waitingForPlayers: 'Waiting for other players...',
        drawThis: 'Draw this:',
        guessDrawing: 'What is this drawing?',
        guessPlaceholder: 'Type your guess...',
        submitGuess: 'Submit',
        submittedCount: 'submitted',
        chainResults: 'Chain Results',
        nextChain: 'Next Chain',
        allChainsComplete: 'All chains complete!',
        originalPhrase: 'Original',
        drewAs: 'drew it as',
        guessedAs: 'guessed',
        maxRounds: 'Max Rounds',
        textDuration: 'Text Entry Time',
        drawDuration: 'Drawing Time',
        guessDuration: 'Guessing Time',
        auto: 'Auto',
        needMorePlayers: 'Need at least 3 players for Telephone',
    },

    uk: {
        // Page title
        pageTitle: 'Вечірні Ігри',

        // Login view
        enterNickname: 'Введіть нікнейм',
        nicknamePlaceholder: 'Ваш крутий нікнейм...',
        generateRandom: 'Згенерувати випадковий',
        enterLobby: 'Увійти в лобі',

        // Lobby view
        joinWithCode: 'Приєднатися за кодом',
        joinGame: 'ПРИЄДНАТИСЯ',
        hostGame: 'Створити гру',
        hostDescription: 'Створіть нову кімнату та поділіться 6-значним кодом з друзями.',
        createNewGame: 'СТВОРИТИ НОВУ ГРУ',

        // Header
        playingAs: 'Граєте як:',
        switchToLight: 'Світла тема',
        switchToDark: 'Темна тема',

        // Room navigation
        leave: 'Вийти',
        code: 'Код',
        ready: 'Готовий',
        unready: 'Не готовий',
        startGame: 'Почати гру',
        live: 'Гра йде!',

        // Settings
        settings: 'Налаштування',
        theme: 'Тема',
        hostRole: 'Роль хоста',
        player: 'Гравець',
        spectator: 'Глядач',
        roundDuration: 'Тривалість раунду',
        pointsToWin: 'Очок для перемоги',
        basePoints: 'Базові очки (перша відповідь)',
        turnOrder: 'Порядок ходів',
        sequential: 'По черзі',
        winnerFirst: 'Хто першим вгадав',
        language: 'Мова',
        difficulty: 'Складність',
        onlyHostSettings: 'Тільки хост може змінювати налаштування.',

        // Game area
        drawing: 'Малюйте',
        startRound: 'ПОЧАТИ РАУНД!',
        roundProcessing: 'Обробка раунду...',

        // Chat & Players
        chat: 'Чат',
        players: 'Гравці',
        typeMessage: 'Напишіть повідомлення...',
        typeGuess: 'Введіть відповідь...',
        guessedCorrectly: 'Ви вгадали!',
        send: 'Надіслати',
        you: '(ви)',
        drawer: '(Малювач)',

        // Host disconnected modal
        gamePaused: 'Гру призупинено',
        hostDisconnectedWaiting: 'Хост відключився. Очікування повторного підключення...',

        // Game over modal
        gameOver: 'ГРА ЗАКІНЧЕНА!',
        wordWas: 'Слово було:',
        yourWord: 'Ваше слово',
        winner: 'Переможець',
        leaderboard: 'Таблиця лідерів',
        playAgain: 'Грати знову',
        leaveRoom: 'Покинути кімнату',

        // Results modal
        nextUp: 'Далі:',
        wasDrawing: 'малював',
        waitFor: 'Чекаємо на',
        total: 'Всього:',
        guessedIn: 'Вгадано за',

        // Invite modal
        inviteFriends: 'Запросити друзів',
        shareLink: 'Поділіться посиланням або QR-кодом з Вашими друзями',
        copyLink: 'Копіювати',
        copied: '✓ Скопійовано!',
        close: 'Закрити',

        // Leave modals
        endSession: 'Завершити сесію?',
        hostLeaveWarning: 'Як хост, покинувши кімнату, Ви закриєте її для всіх гравців.',
        leaveCloseRoom: 'ВИЙТИ І ЗАКРИТИ',
        stayInGame: 'ЗАЛИШИТИСЯ',
        leaveGame: 'Вийти з гри?',
        playerLeaveWarning: 'Ви не зможете повторно приєднатися до цієї гри після виходу. Ви впевнені?',
        leaveGameBtn: 'ВИЙТИ З ГРИ',

        // Notifications
        joined: 'приєднався',
        reconnected: 'повернувся',
        left: 'вийшов',
        disconnected: 'Відключено',
        hostDisconnected: 'Хост відключився',
        hostReconnected: 'Хост повернувся',
        roomClosed: 'Кімнату закрито хостом',
        failedToCreate: 'Не вдалося створити кімнату',
        failedToLoad: 'Не вдалося завантажити набори слів. Будь ласка, оновіть сторінку.',
        wordSetsLoading: 'Набори слів ще завантажуються. Зачекайте...',
        gameLogicNotInit: 'Логіка гри не ініціалізована',

        // Random name generator
        adjectives: ['Веселий', 'Хитрий', 'Сміливий', 'Розумний', 'Швидкий', 'Могутній'],
        nouns: ['Панда', 'Тигр', 'Орел', 'Лис', 'Вовк', 'Ведмідь'],

        // Game types
        selectGame: 'Оберіть гру',
        alligator: 'Крокодил',
        alligatorDesc: 'Класична гра - вгадуй що малюють інші!',
        telephone: 'Телефон',
        telephoneDesc: 'Пиши → Малюй → Вгадуй по ланцюжку!',

        // Telephone game
        enterPhrase: 'Введіть фразу для малювання',
        phrasePlaceholder: 'Щось цікаве...',
        submitPhrase: 'Відправити',
        waitingForPlayers: 'Чекаємо інших гравців...',
        drawThis: 'Намалюй це:',
        guessDrawing: 'Що на малюнку?',
        guessPlaceholder: 'Ваша здогадка...',
        submitGuess: 'Відправити',
        submittedCount: 'відправили',
        chainResults: 'Результати ланцюжка',
        nextChain: 'Наступний ланцюжок',
        allChainsComplete: 'Всі ланцюжки завершено!',
        originalPhrase: 'Оригінал',
        drewAs: 'намалював',
        guessedAs: 'вгадав',
        maxRounds: 'Макс. раундів',
        textDuration: 'Час на текст',
        drawDuration: 'Час на малюнок',
        guessDuration: 'Час на відповідь',
        auto: 'Авто',
        needMorePlayers: 'Потрібно мінімум 3 гравці для Телефону',
    }
};

const i18n = {
    currentLang: 'en',
    
    init() {
        const saved = localStorage.getItem('lang');
        if (saved && translations[saved]) {
            this.currentLang = saved;
        } else {
            // Detect browser language
            const browserLang = navigator.language || navigator.userLanguage;
            // Get base language code (e.g., "uk-UA" -> "uk", "en-US" -> "en")
            const baseLang = browserLang.split('-')[0].toLowerCase();
            if (translations[baseLang]) {
                this.currentLang = baseLang;
            }
        }
    },
    
    setLang(lang) {
        if (translations[lang]) {
            this.currentLang = lang;
            localStorage.setItem('lang', lang);
        }
    },
    
    t(key) {
        return translations[this.currentLang]?.[key] || translations.en[key] || key;
    },
    
    getLanguages() {
        return Object.keys(translations);
    },
    
    getLangName(code) {
        const names = { en: 'English', uk: 'Українська' };
        return names[code] || code;
    }
};

i18n.init();
