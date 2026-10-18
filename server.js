const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let gameState = {
    players: {},
    pot: 0,
    currentHighestBet: 0,
    dealerIndex: 0,
    currentTurnId: null,
    history: []
};

function addLog(message) {
    gameState.history.unshift(message);
    if (gameState.history.length > 20) {
        gameState.history.pop();
    }
}

function getActivePlayerIds() {
    return Object.keys(gameState.players).filter(id => {
        let p = gameState.players[id];
        return !p.folded && (p.chips > 0 || p.currentBet > 0);
    });
}

function updateTurnAfterAction(currentSocketId) {
    let playerIds = Object.keys(gameState.players);
    if (playerIds.length === 0) {
        gameState.currentTurnId = null;
        return;
    }

    let activeIds = getActivePlayerIds();
    if (activeIds.length === 0) {
        gameState.currentTurnId = null;
        return;
    }

    let currentIndex = playerIds.indexOf(currentSocketId);
    let nextIndex = (currentIndex + 1) % playerIds.length;
    let attempts = 0;

    while (attempts < playerIds.length) {
        let candidateId = playerIds[nextIndex];
        let p = gameState.players[candidateId];
        if (p && !p.folded && p.chips > 0) {
            gameState.currentTurnId = candidateId;
            return;
        }
        nextIndex = (nextIndex + 1) % playerIds.length;
        attempts++;
    }
}

io.on('connection', (socket) => {
    console.log(`Jugador conectado: ${socket.id}`);

    socket.on('join-game', ({ name, initialChips }) => {
        let cleanName = name || `Jugador ${Object.keys(gameState.players).length + 1}`;
        let defaultChips = parseInt(initialChips) || 1000;

        if (gameState.players[socket.id]) {
            gameState.players[socket.id].name = cleanName;
        } else {
            let existingKey = Object.keys(gameState.players).find(id => gameState.players[id].name === cleanName);
            
            if (existingKey) {
                let oldPlayer = gameState.players[existingKey];
                delete gameState.players[existingKey];
                gameState.players[socket.id] = oldPlayer;
                gameState.players[socket.id].id = socket.id;
            } else {
                gameState.players[socket.id] = {
                    id: socket.id,
                    name: cleanName,
                    chips: defaultChips,
                    currentBet: 0,
                    folded: false
                };
                addLog(`👋 ${cleanName} se unió a la mesa con ${defaultChips} fichas.`);
            }
        }

        if (!gameState.currentTurnId) {
            gameState.currentTurnId = socket.id;
        }

        io.emit('update-game', gameState);
    });

    socket.on('logout-player', () => {
        let player = gameState.players[socket.id];
        if (player) {
            addLog(`🚪 ${player.name} abandonó la mesa.`);
            delete gameState.players[socket.id];
            
            if (gameState.currentTurnId === socket.id) {
                updateTurnAfterAction(socket.id);
            }
            io.emit('update-game', gameState);
        }
    });

    socket.on('place-bet', (amount) => {
        let player = gameState.players[socket.id];
        if (!player || player.folded || player.chips <= 0) return;

        if (amount > player.chips) return;

        player.chips -= amount;
        player.currentBet += amount;
        gameState.pot += amount;

        let isAllIn = player.chips === 0;

        if (player.currentBet > gameState.currentHighestBet) {
            gameState.currentHighestBet = player.currentBet;
        }

        if (isAllIn) {
            addLog(`🔥 ¡${player.name} fue ALL-IN con ${player.currentBet} fichas!`);
        } else {
            addLog(`💰 ${player.name} apostó ${amount} fichas (Total: ${player.currentBet}).`);
        }

        updateTurnAfterAction(socket.id);
        io.emit('update-game', gameState);
    });

    socket.on('check', () => {
        let player = gameState.players[socket.id];
        if (!player || player.folded) return;

        // Solo se puede hacer check si la apuesta a igualar es 0
        let difference = gameState.currentHighestBet - player.currentBet;
        if (difference === 0) {
            addLog(`👉 ${player.name} hizo Check (Pasó).`);
            updateTurnAfterAction(socket.id);
            io.emit('update-game', gameState);
        }
    });

    socket.on('call', () => {
        let player = gameState.players[socket.id];
        if (!player || player.folded || player.chips <= 0) return;

        let difference = gameState.currentHighestBet - player.currentBet;
        if (difference <= 0) return;

        if (difference > player.chips) {
            difference = player.chips;
        }

        player.chips -= difference;
        player.currentBet += difference;
        gameState.pot += difference;

        if (player.chips === 0) {
            addLog(`🔥 ¡${player.name} igualó y quedó ALL-IN con ${player.currentBet} fichas!`);
        } else {
            addLog(`🤝 ${player.name} igualó (Call) ${difference} fichas.`);
        }

        updateTurnAfterAction(socket.id);
        io.emit('update-game', gameState);
    });

    socket.on('fold', () => {
        let player = gameState.players[socket.id];
        if (player) {
            player.folded = true;
            addLog(`❌ ${player.name} hizo Fold (se retiró).`);
            updateTurnAfterAction(socket.id);
            io.emit('update-game', gameState);
        }
    });

    socket.on('win-pot', (winnerId) => {
        let winner = gameState.players[winnerId];
        if (!winner || winner.folded || (winner.chips <= 0 && winner.currentBet === 0)) return;

        let activePlayers = getActivePlayerIds();
        if (activePlayers.length > 2) return;

        let totalWon = gameState.pot;
        winner.chips += gameState.pot;
        gameState.pot = 0;
        gameState.currentHighestBet = 0;

        addLog(`🏆 ¡${winner.name} se llevó el pozo de ${totalWon} fichas!`);

        Object.values(gameState.players).forEach(p => {
            p.currentBet = 0;
            p.folded = false;
        });

        updateTurnAfterAction(winnerId);
        io.emit('update-game', gameState);
    });

    socket.on('split-pot', () => {
        let activePlayers = Object.values(gameState.players).filter(p => !p.folded && (p.chips > 0 || p.currentBet > 0));
        if (activePlayers.length === 0 || gameState.pot <= 0) return;

        let totalPot = gameState.pot;
        let share = Math.floor(gameState.pot / activePlayers.length);
        let remainder = gameState.pot % activePlayers.length;

        activePlayers.forEach((p, index) => {
            p.chips += share + (index < remainder ? 1 : 0);
        });

        addLog(`⚖️ Se repartió el pozo de ${totalPot} fichas entre ${activePlayers.length} jugadores (${share} c/u).`);

        gameState.pot = 0;
        gameState.currentHighestBet = 0;

        Object.values(gameState.players).forEach(p => {
            p.currentBet = 0;
            p.folded = false;
        });

        io.emit('update-game', gameState);
    });

    socket.on('next-dealer', () => {
        let playerIds = Object.keys(gameState.players);
        if (playerIds.length === 0) return;

        gameState.dealerIndex = (gameState.dealerIndex + 1) % playerIds.length;
        let dealerPlayer = gameState.players[playerIds[gameState.dealerIndex]];
        addLog(`🔘 El Botón de Dealer pasó a ${dealerPlayer ? dealerPlayer.name : 'siguiente'}.`);
        io.emit('update-game', gameState);
    });

    socket.on('reset-hand', () => {
        gameState.pot = 0;
        gameState.currentHighestBet = 0;
        Object.values(gameState.players).forEach(p => {
            p.currentBet = 0;
            p.folded = false;
        });
        addLog(`🔄 Se limpió el pozo y se reinició la mano.`);
        io.emit('update-game', gameState);
    });

    socket.on('reset-all-game', () => {
        gameState = {
            players: {},
            pot: 0,
            currentHighestBet: 0,
            dealerIndex: 0,
            currentTurnId: null,
            history: []
        };
        addLog(`🚨 La sala fue reiniciada por completo.`);
        io.emit('update-game', gameState);
    });

    socket.on('disconnect', () => {
        console.log(`Jugador desconectado: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});
