const WebSocket = require("ws");
require("dotenv").config();
const { Pool } = require("pg");
const express = require("express");
const path = require("path");
const fs = require("fs");
const {
  TikTokLiveConnection,
  WebcastEvent
} = require("tiktok-live-connector");

const app = express();
app.get("/test", (req, res) => {
  res.send("TEST OK");
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS timer_state (
      id INTEGER PRIMARY KEY,
      total_seconds BIGINT NOT NULL DEFAULT 0,
      paused BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    INSERT INTO timer_state (id, total_seconds, paused)
    VALUES (1, 0, true)
    ON CONFLICT (id) DO NOTHING;
  `);

  console.log("✅ Base de données timer prête");
}

if (process.env.DATABASE_URL) {
  initDatabase().catch(console.error);
} else {
  console.log("⚠️ Mode local : PostgreSQL désactivé");
}

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.redirect("/dashboard");
});

app.get("/dashboard", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "dashboard.html")
  );
});

app.get("/timer", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "timer.html")
  );
});

// ================================
// TIMER
// ================================

const DATA_FILE =
  path.join(__dirname, "data.json");
  const TWITCH_CLIENT_ID =
  process.env.TWITCH_CLIENT_ID;

const TWITCH_CLIENT_SECRET =
  process.env.TWITCH_CLIENT_SECRET;

const TWITCH_REDIRECT_URI =
  process.env.TWITCH_REDIRECT_URI;

let twitchAccessToken = null;
let twitchUser = null;

let totalSeconds = 8 * 60 * 60;
let paused = false;
let giftRules = [];
let twitchEventSubSocket = null;

async function loadData() {

  // Sur Render : charger depuis PostgreSQL
  if (process.env.DATABASE_URL) {
    try {
      await initDatabase();

      const result = await pool.query(`
        SELECT total_seconds, paused, updated_at
        FROM timer_state
        WHERE id = 1
      `);

    if (result.rows.length > 0) {
  const row = result.rows[0];

  totalSeconds = Number(row.total_seconds);

  // Après une coupure, le timer reste au temps sauvegardé
  // et redémarre toujours en pause.
  paused = true;

  await saveData();
}

      console.log(
        "✅ Timer récupéré depuis PostgreSQL :",
        totalSeconds,
        "secondes"
      );

      return;

    } catch (error) {
      console.error(
        "Erreur chargement PostgreSQL :",
        error.message
      );
    }
  }

  // Sur ton PC : utiliser data.json
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return;
    }

    const raw =
      fs.readFileSync(DATA_FILE, "utf8");

    const data =
      JSON.parse(raw);

    if (Number.isFinite(data.totalSeconds)) {
      totalSeconds = data.totalSeconds;
    }

    if (typeof data.paused === "boolean") {
      paused = data.paused;
    }

    if (Array.isArray(data.giftRules)) {
      giftRules = data.giftRules;
    }

    console.log("Données sauvegardées chargées ✅");

  } catch (error) {
    console.error(
      "Erreur chargement :",
      error.message
    );
  }
}


async function saveData() {
  const data = {
    totalSeconds: totalSeconds,
    paused: paused,
    giftRules: giftRules
  };

  // Sur Render : sauvegarde PostgreSQL
  if (process.env.DATABASE_URL) {
    try {
      await pool.query(
        `
        UPDATE timer_state
        SET total_seconds = $1,
            paused = $2,
            updated_at = NOW()
        WHERE id = 1
        `,
        [totalSeconds, paused]
      );
    } catch (error) {
      console.error(
        "Erreur sauvegarde PostgreSQL :",
        error.message
      );
    }

    return;
  }

  // Sur ton PC : garde data.json
  try {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(data, null, 2)
    );
  } catch (error) {
    console.error(
      "Erreur sauvegarde :",
      error.message
    );
  }
}


loadData().catch(console.error);

let detectedGifts = [];

let tiktokConnection = null;
let connectedTikTokUsername = null;

setInterval(() => {

  if (!paused && totalSeconds > 0) {
    totalSeconds--;
  }

}, 1000);


// Sauvegarde automatique toutes les 5 secondes
setInterval(() => {

  saveData();

}, 5000);

// ================================
// PAGES
// ================================

app.get("/dashboard", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "dashboard.html")
  );
});

app.get("/timer", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "timer.html")
  );
});

// ================================
// TIMER API
// ================================

app.get("/api/time", (req, res) => {
  res.json({
    seconds: totalSeconds,
    paused: paused
  });
});

app.post("/api/add", (req, res) => {

  const seconds = Number(req.body.seconds);

  if (!Number.isFinite(seconds)) {
    return res.status(400).json({
      success: false,
      message: "Temps invalide"
    });
  }

  totalSeconds += seconds;

  if (totalSeconds < 0) {
    totalSeconds = 0;
  }

  res.json({
    success: true,
    seconds: totalSeconds
  });
});

app.post("/api/set-time", (req, res) => {
  const hours = Number(req.body.hours || 0);
  const minutes = Number(req.body.minutes || 0);
  const seconds = Number(req.body.seconds || 0);

  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds) ||
    hours < 0 ||
    minutes < 0 ||
    seconds < 0 ||
    minutes > 59 ||
    seconds > 59
  ) {
    return res.status(400).json({
      success: false,
      message: "Temps invalide"
    });
  }

  totalSeconds =
    (hours * 3600) +
    (minutes * 60) +
    seconds;

  saveData();

  res.json({
    success: true,
    seconds: totalSeconds
  });
});

app.post("/api/pause", (req, res) => {

  paused = !paused;
  saveData();

  res.json({
    success: true,
    paused: paused
  });
});


// ================================
// RÈGLES CADEAUX
// ================================

// Obtenir toutes les règles
app.get("/api/gifts", (req, res) => {
  res.json(giftRules);
});

// Ajouter une règle
app.post("/api/gifts", (req, res) => {


const giftId =
  String(req.body.giftId || "").trim();

const giftName =
  String(req.body.giftName || "").trim();

const seconds =
  Number(req.body.seconds);

if (
  !giftId ||
  !giftName ||
  !Number.isFinite(seconds) ||
  seconds <= 0
) {
  return res.status(400).json({
    success: false,
    message: "Règle invalide"
  });
}

const rule = {
  id: Date.now(),
  giftId: giftId,
  giftName: giftName,
  seconds: seconds
};

  giftRules.push(rule);
  saveData();

  console.log(
    "Nouvelle règle : " +
    giftName +
    " = +" +
    seconds +
    " secondes"
  );

  res.json({
    success: true,
    rule: rule
  });
});// Supprimer une règle
app.delete("/api/gifts/:id", (req, res) => {

  const id = Number(req.params.id);

  giftRules = giftRules.filter(
    rule => rule.id !== id
  );
  saveData();

  res.json({
    success: true
  });
});

// ================================
// TIKTOK
// ================================

app.post("/api/tiktok/connect", async (req, res) => {

  const username = String(
    req.body.username || ""
  )
    .trim()
    .replace("@", "");

  if (!username) {
    return res.status(400).json({
      success: false,
      message: "Nom TikTok manquant"
    });
  }

  try {

    // Fermer l'ancienne connexion
    if (tiktokConnection) {
      try {
        tiktokConnection.disconnect();
      } catch (error) {
        // Rien à faire
      }
    }

    tiktokConnection =
  new TikTokLiveConnection({
    uniqueId: username
  });

    await tiktokConnection.connect();

    connectedTikTokUsername = username;

    console.log(
      "TikTok connecté à @" + username
    );

    // ==============================
    // DÉTECTION AUTOMATIQUE DES GIFTS
    // ==============================

   tiktokConnection.on("gift", (data) => {

  const giftName =
    String(data.giftName || "Cadeau TikTok");

  const coinValue =
    Number(data.diamondCount || 0);

  const quantity =
    Number(data.repeatCount || 1);

  const giftType =
    Number(data.giftType || 0);

  const repeatEnd =
    Boolean(data.repeatEnd);


  // Les cadeaux en streak envoient plusieurs events.
  // On attend le dernier pour ne pas compter plusieurs fois.
  if (giftType === 1 && !repeatEnd) {
    return;
  }


  const totalCoins =
    coinValue * quantity;

  if (
    !Number.isFinite(totalCoins) ||
    totalCoins <= 0
  ) {
    console.log(
      "⚠️ Valeur TikTok introuvable pour " +
      giftName
    );

    return;
  }


  // 1 coin = 1 seconde
  totalSeconds += totalCoins;

  saveData();


  console.log(
    "🎁 TikTok : " +
    giftName +
    " x" +
    quantity +
    " = " +
    totalCoins +
    " coins → +" +
    totalCoins +
    " secondes"
  );

});


    res.json({
      success: true,
      username: username
    });

  } catch (error) {

    console.error(
      "Erreur TikTok :",
      error.message
    );

    tiktokConnection = null;
    connectedTikTokUsername = null;

    res.status(500).json({
      success: false,
      message:
        "Impossible de se connecter au LIVE TikTok"
    });
  }
});

// ================================
// STATUT TIKTOK
// ================================

app.get("/api/tiktok/status", (req, res) => {

  res.json({
    connected:
      connectedTikTokUsername !== null,

    username:
      connectedTikTokUsername
  });
});
// ================================
// CADEAUX TIKTOK DÉTECTÉS
// ================================

app.get("/api/tiktok/gifts", (req, res) => {

  res.json(detectedGifts);

});
// ================================
// LANCEMENT
// ================================

// ==========================================
// TWITCH EVENTSUB
// ==========================================

function startTwitchEventSub() {
  if (!twitchUser || !twitchAccessToken) {
    console.log("❌ Twitch EventSub : utilisateur ou token manquant");
    return;
  }

  console.log("🔌 Démarrage Twitch EventSub...");

  const ws = new WebSocket(
    "wss://eventsub.wss.twitch.tv/ws"
  );

  ws.on("open", () => {
    console.log("🔌 Twitch EventSub connecté");
  });

  ws.on("message", async (rawData) => {
    try {
      const message = JSON.parse(rawData.toString());

      if (
        message.metadata &&
        message.metadata.message_type ===
          "session_welcome"
      ) {
        const sessionId =
          message.payload.session.id;

        console.log(
          "✅ Session EventSub : " +
          sessionId
        );

        await createTwitchSubscriptions(
          sessionId
        );
      }

      if (
        message.metadata &&
        message.metadata.message_type ===
          "notification"
      ) {
        handleTwitchEvent(message);
      }
    } catch (error) {
      console.error(
        "Erreur EventSub :",
        error
      );
    }
  });

  ws.on("error", (error) => {
    console.error(
      "Erreur WebSocket Twitch :",
      error
    );
  });

  ws.on("close", () => {
    console.log(
      "⚠️ Twitch EventSub déconnecté"
    );
  });
}

async function createTwitchSubscriptions(sessionId) {

  const subscriptions = [
  "channel.subscribe",
  "channel.subscription.gift",
  "stream.offline"
];

  for (const type of subscriptions) {

    const response = await fetch(
      "https://api.twitch.tv/helix/eventsub/subscriptions",
      {
        method: "POST",
        headers: {
          "Client-ID": TWITCH_CLIENT_ID,
          "Authorization":
            "Bearer " + twitchAccessToken,
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          type: type,
          version: "1",
          condition: {
            broadcaster_user_id:
              twitchUser.id
          },
          transport: {
            method: "websocket",
            session_id: sessionId
          }
        })
      }
    );

    const data =
      await response.json();

    console.log(
      "EventSub " +
      type +
      " : " +
      response.status
    );

    if (!response.ok) {
      console.log(data);
    }
  }
}


function handleTwitchEvent(message) {

  const type =
    message.metadata.subscription_type;

  const event =
    message.payload.event;

  if (type === "channel.subscribe") {

    if (event.is_gift) {
      return;
    }

    totalSeconds += 8 * 60;

    saveData();

    console.log(
      "⭐ Nouveau sub Twitch → +8 min"
    );
  }

  if (
    type ===
    "channel.subscription.gift"
  ) {

    const amount =
      Number(event.total || 1);

    const secondsAdded =
      amount * 8 * 60;

    totalSeconds += secondsAdded;

    saveData();

    console.log(
      "🎁 " +
      amount +
      " gift sub(s) → +" +
      amount * 8 +
      " min"
    );
  }

  if (type === "stream.offline") {

    paused = true;

    saveData();

    console.log(
      "🔴 Twitch OFFLINE → timer mis en pause automatiquement"
    );
  }
}

app.get("/auth/twitch", (req, res) => {

  const scopes = [
    "channel:read:subscriptions"
  ].join(" ");

  const twitchAuthUrl =
    "https://id.twitch.tv/oauth2/authorize" +
    "?client_id=" +
    encodeURIComponent(TWITCH_CLIENT_ID) +
    "&redirect_uri=" +
    encodeURIComponent(TWITCH_REDIRECT_URI) +
    "&response_type=code" +
    "&scope=" +
    encodeURIComponent(scopes);

  res.redirect(twitchAuthUrl);

});

app.get("/auth/twitch/callback", async (req, res) => {

  const code = req.query.code;

  if (!code) {
    return res.send(
      "Connexion Twitch annulée ou invalide."
    );
  }

  try {

    const tokenResponse = await fetch(
      "https://id.twitch.tv/oauth2/token",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          client_id: TWITCH_CLIENT_ID,
          client_secret: TWITCH_CLIENT_SECRET,
          code: code,
          grant_type: "authorization_code",
          redirect_uri: TWITCH_REDIRECT_URI
        })
      }
    );

    const tokenData =
      await tokenResponse.json();

    if (!tokenData.access_token) {

      console.log(
        "Erreur token Twitch:",
        tokenData
      );

      return res.send(
        "Erreur pendant la connexion Twitch."
      );
    }

    twitchAccessToken =
      tokenData.access_token;

    const userResponse = await fetch(
      "https://api.twitch.tv/helix/users",
      {
        headers: {
          "Client-ID": TWITCH_CLIENT_ID,
          "Authorization":
            "Bearer " + twitchAccessToken
        }
      }
    );

    const userData =
      await userResponse.json();

    twitchUser =
      userData.data?.[0];

    if (!twitchUser) {
      return res.send(
        "Impossible de récupérer le compte Twitch."
      );
    }

    console.log(
      "✅ Twitch connecté : @" +
      twitchUser.login
    );

    startTwitchEventSub();

    res.redirect("/dashboard");

  } catch (error) {

    console.error(
      "Erreur OAuth Twitch:",
      error
    );

    res.send(
      "Erreur pendant la connexion Twitch."
    );
  }

});

app.get("/api/twitch/status", (req, res) => {
  res.json({
    connected: !!twitchUser,
    username: twitchUser ? twitchUser.login : null
  });
});

app.get("/api/twitch/status", (req, res) => {
  res.json({
    connected: !!twitchUser,
    username: twitchUser ? twitchUser.login : null
  });
});

async function createTwitchEventSub(type, sessionId) {

  const response = await fetch(
    "https://api.twitch.tv/helix/eventsub/subscriptions",
    {
      method: "POST",

      headers: {
        "Client-ID": TWITCH_CLIENT_ID,
        "Authorization": "Bearer " + twitchAccessToken,
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        type: type,
        version: "1",

        condition: {
          broadcaster_user_id: twitchUser.id
        },

        transport: {
          method: "websocket",
          session_id: sessionId
        }
      })
    }
  );

  const data = await response.json();

  console.log(
    "EventSub " + type + ":",
    response.status,
    data
  );
}

async function createTwitchEventSub(type, sessionId) {

  const response = await fetch(
    "https://api.twitch.tv/helix/eventsub/subscriptions",
    {
      method: "POST",

      headers: {
        "Client-ID": TWITCH_CLIENT_ID,
        "Authorization": "Bearer " + twitchAccessToken,
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        type: type,
        version: "1",

        condition: {
          broadcaster_user_id: twitchUser.id
        },

        transport: {
          method: "websocket",
          session_id: sessionId
        }
      })
    }
  );

  const data = await response.json();

  console.log(
    "EventSub " + type + ":",
    response.status,
    data
  );
}

// ================================
// TEST TWITCH
// ================================

app.post("/api/test/twitch/sub", (req, res) => {
  totalSeconds += 8 * 60;
  saveData();

  console.log("🧪 TEST Twitch sub → +8 min");

  res.json({
    success: true,
    addedSeconds: 480,
    seconds: totalSeconds
  });
});


app.post("/api/test/twitch/gifts", (req, res) => {
  const amount = Number(req.body.amount || 5);

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({
      success: false,
      message: "Quantité invalide"
    });
  }

  const secondsAdded =
    amount * 8 * 60;

  totalSeconds += secondsAdded;
  saveData();

  console.log(
    "🧪 TEST Twitch gifts x" +
    amount +
    " → +" +
    amount * 8 +
    " min"
  );

  res.json({
    success: true,
    amount: amount,
    addedSeconds: secondsAdded,
    seconds: totalSeconds
  });
});

app.post("/api/test/tiktok/coins", (req, res) => {
  const coins = Number(req.body.coins);

  if (!Number.isFinite(coins) || coins <= 0) {
    return res.status(400).json({
      success: false,
      message: "Nombre de coins invalide"
    });
  }

  totalSeconds += coins;
  saveData();

  console.log(
    "🧪 TEST TikTok : " +
    coins +
    " coins → +" +
    coins +
    " secondes"
  );

  res.json({
    success: true,
    coins: coins,
    addedSeconds: coins,
    seconds: totalSeconds
  });
});

app.post("/api/test/twitch/offline", async (req, res) => {

  paused = true;

  await saveData();

  console.log(
    "🧪 TEST Twitch OFFLINE → timer mis en pause"
  );

  res.json({
    success: true,
    paused: paused,
    seconds: totalSeconds
  });

});
app.post("/api/play", async (req, res) => {
  paused = false;

  await saveData();

  console.log("▶ Timer démarré");

  res.json({
    success: true,
    paused: false,
    seconds: totalSeconds
  });
});

app.post("/api/stop", async (req, res) => {
  paused = true;

  await saveData();

  console.log("⏸ Timer mis en pause");

  res.json({
    success: true,
    paused: true,
    seconds: totalSeconds
  });
});

app.post("/api/tiktok/connect", async (req, res) => {
  const username = String(req.body.username || "")
    .trim()
    .replace("@", "");

  if (!username) {
    return res.status(400).json({
      success: false,
      message: "Nom TikTok manquant"
    });
  }

  console.log(
    "📱 Tentative connexion TikTok LIVE : @" + username
  );

  try {
    if (tiktokConnection) {
      try {
        tiktokConnection.disconnect();
      } catch (error) {}
    }

    tiktokConnection =
      new WebcastPushConnection(username);

    const state =
      await tiktokConnection.connect();

    console.log(
      "✅ TikTok LIVE connecté : @" + username
    );

    console.log(
      "Room ID TikTok : " + state.roomId
    );

    res.json({
      success: true,
      username: username
    });

  } catch (error) {
    console.error(
      "❌ Connexion TikTok impossible :",
      error.message
    );

    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.listen(PORT, () => {



  console.log("SUBATHON APP démarrée");

  console.log(
    "Dashboard : http://localhost:" +
    PORT +
    "/dashboard"
  );

  console.log(
    "Timer OBS : http://localhost:" +
    PORT +
    "/timer"
  );

});