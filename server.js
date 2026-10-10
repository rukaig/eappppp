require("dotenv").config();

const path = require("path");
const http = require("http");
const crypto = require("crypto");
const express = require("express");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const realtime = new WebSocketServer({ noServer: true });
const rooms = new Map();
const roomNames = new Map();
const studyCategories = new Set(["Assignment", "Exam review", "Group project", "Research", "Presentation", "Other"]);
const voiceRequestWindows = new Map();
const port = Number(process.env.PORT) || 3000;
const clientRoot = __dirname;
const modelApiBaseUrl = (process.env.MODEL_API_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, "");
const tencentAsrHost = "asr.tencentcloudapi.com";
const schoolAssistantInstructions = [
  "You are EAPIHS Assistant, a supportive school learning assistant.",
  "Help with age-appropriate explanations, homework guidance, study plans, computer and internet basics, and school technology questions.",
  "Teach step by step and use simple language. Ask a short clarifying question when the student's request is ambiguous.",
  "Do not do graded work dishonestly or encourage cheating; explain the method and help the student learn.",
  "Do not invent school policies, sources, grades, or facts. Say when you are uncertain and suggest asking a teacher for important decisions.",
  "Protect privacy: never request passwords, API keys, exact home addresses, or other sensitive personal information.",
  "Keep answers concise, encouraging, and suitable for a school environment."
].join(" ");

app.use(express.json({ limit: "32kb" }));

app.post("/api/voice/recognize", express.raw({ type: ["audio/wav", "audio/x-wav"], limit: "2mb" }), async (req, res) => {
  const secretId = process.env.TENCENTCLOUD_SECRET_ID;
  const secretKey = process.env.TENCENTCLOUD_SECRET_KEY;
  if (!secretId || !secretKey) {
    return res.status(503).json({ error: "Tencent ASR is not configured. Add its SecretId and SecretKey to .env, then restart the server." });
  }

  if (!Buffer.isBuffer(req.body) || !req.body.length || !req.is(["audio/wav", "audio/x-wav"])) {
    return res.status(415).json({ error: "Upload a WAV recording to check pronunciation." });
  }
  if (req.body.length < 44 || req.body.toString("ascii", 0, 4) !== "RIFF" || req.body.toString("ascii", 8, 12) !== "WAVE") {
    return res.status(400).json({ error: "The recording is not a valid WAV file. Please record it again." });
  }
  if (isVoiceRateLimited(req.ip)) {
    return res.status(429).json({ error: "Too many voice checks just now. Wait a minute and try again." });
  }

  const region = process.env.TENCENTCLOUD_ASR_REGION || "ap-guangzhou";
  const projectId = Number(process.env.TENCENTCLOUD_ASR_PROJECT_ID) || 0;
  const requestBody = JSON.stringify({
    ProjectId: projectId,
    SubServiceType: 2,
    EngSerViceType: "16k_en",
    SourceType: 1,
    VoiceFormat: "wav",
    Data: req.body.toString("base64"),
    DataLen: req.body.length,
    FilterPunc: 1
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const contentType = "application/json; charset=utf-8";
  const canonicalHeaders = `content-type:${contentType}\nhost:${tencentAsrHost}\n`;
  const signedHeaders = "content-type;host";
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaders, sha256(requestBody)].join("\n");
  const credentialScope = `${date}/asr/tc3_request`;
  const stringToSign = ["TC3-HMAC-SHA256", String(timestamp), credentialScope, sha256(canonicalRequest)].join("\n");
  const secretDate = hmacSha256(`TC3${secretKey}`, date);
  const secretService = hmacSha256(secretDate, "asr");
  const secretSigning = hmacSha256(secretService, "tc3_request");
  const signature = hmacSha256(secretSigning, stringToSign, "hex");
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  try {
    const response = await fetch(`https://${tencentAsrHost}/`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": contentType,
        "X-TC-Action": "SentenceRecognition",
        "X-TC-Version": "2019-06-14",
        "X-TC-Region": region,
        "X-TC-Timestamp": String(timestamp)
      },
      body: requestBody,
      signal: AbortSignal.timeout(12000)
    });
    const data = await response.json();
    const result = data.Response;
    if (!response.ok || result?.Error) {
      console.error("Tencent ASR request failed:", result?.Error?.Code || response.status, result?.RequestId || "no request id");
      return res.status(502).json({ error: "Tencent ASR could not recognize that recording. Check that ASR is enabled and try again." });
    }
    return res.json({ transcript: typeof result?.Result === "string" ? result.Result : "", requestId: result?.RequestId });
  } catch (error) {
    console.error("Tencent ASR connection failed:", error.name || "UnknownError");
    return res.status(502).json({ error: "The voice recognition service is temporarily unreachable. Retry, or continue without a pronunciation score." });
  }
});

function isVoiceRateLimited(ip) {
  const now = Date.now();
  const windowMs = 60_000;
  const limit = 120;
  for (const [address, window] of voiceRequestWindows) {
    if (window.expiresAt <= now) voiceRequestWindows.delete(address);
  }
  const window = voiceRequestWindows.get(ip);
  if (!window || window.expiresAt <= now) {
    voiceRequestWindows.set(ip, { count: 1, expiresAt: now + windowMs });
    return false;
  }
  window.count++;
  return window.count > limit;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmacSha256(key, value, encoding) {
  const digest = crypto.createHmac("sha256", key).update(value).digest();
  return encoding ? digest.toString(encoding) : digest;
}

app.get("/download/appli.html", (req, res, next) => {
  res.download(path.join(clientRoot, "appli.html"), "appli.html", error => {
    if (error && !res.headersSent) next(error);
  });
});

app.use(express.static(clientRoot));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "eapihs-assistant", realtime: true });
});

app.post("/api/assistant", async (req, res) => {
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
  if (!prompt || prompt.length > 2000) {
    return res.status(400).json({ error: "A prompt between 1 and 2000 characters is required." });
  }

  if (!process.env.MODEL_API_KEY) {
    return res.status(503).json({ error: "The AI assistant is not configured on this server." });
  }

  try {
    const response = await fetch(modelApiBaseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + process.env.MODEL_API_KEY
      },
      body: JSON.stringify({
        model: process.env.MODEL_API_MODEL || "openai/gpt-oss-120b",
        messages: [
          {
            role: "developer",
            content: schoolAssistantInstructions
          },
          { role: "user", content: prompt }
        ],
        temperature: 0.4,
        max_tokens: 300
      }),
      signal: AbortSignal.timeout(15000)
    });

    const data = await response.json();
    if (!response.ok) {
      console.error("Model API request failed:", data);
      return res.status(502).json({ error: "The AI assistant could not answer right now." });
    }

    const answer = data.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      return res.status(502).json({ error: "The AI assistant returned an empty answer." });
    }
    return res.json({ answer });
  } catch (error) {
    console.error("Assistant request failed:", error);
    return res.status(502).json({ error: "The AI assistant is temporarily unavailable." });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(clientRoot, "appli.html"));
});

server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/realtime") {
    socket.destroy();
    return;
  }
  realtime.handleUpgrade(request, socket, head, client => {
    realtime.emit("connection", client, request);
  });
});

realtime.on("connection", socket => {
  socket.id = crypto.randomUUID();
  socket.room = null;

  socket.on("message", raw => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return send(socket, { type: "error", message: "Invalid realtime message." });
    }

    if (message.type === "createRoom") {
      createRoom(socket, message);
      return;
    }

    if (message.type === "join") {
      joinRoom(socket, message.room, message.keyCode, message.name);
      return;
    }

    if (!socket.room) {
      send(socket, { type: "error", message: "Join a room before sending messages." });
      return;
    }

    if (message.type === "chat" || message.type === "coach") {
      const text = typeof message.text === "string" ? message.text.trim().slice(0, 1000) : "";
      const category = typeof message.category === "string" && message.category.length <= 40 ? message.category : "General";
      if (text) {
        const room = rooms.get(socket.room);
        const chatMessage = {
          type: message.type,
          sender: message.type === "coach" ? "Study Coach" : socket.name,
          text,
          category,
          sentAt: Date.now()
        };
        room.history.push(chatMessage);
        if (room.history.length > 100) room.history.shift();
        broadcast(socket.room, chatMessage, socket);
      }
      return;
    }

    if (message.type === "signal") {
      relayToRoom(socket.room, socket, {
        type: "signal",
        senderId: socket.id,
        targetId: message.targetId,
        signal: message.signal
      });
    }
  });

  socket.on("close", () => leaveRoom(socket));
});

function createRoom(socket, message) {
  const name = normalizeChannelName(message.name);
  const keyCode = normalizeKeyCode(message.keyCode);
  const category = typeof message.category === "string" && studyCategories.has(message.category) ? message.category : "Other";
  const goal = typeof message.goal === "string" ? message.goal.trim().slice(0, 240) : "";
  const capacity = Number(message.capacity);
  if (!name || !keyCode || keyCode.length < 4 || keyCode.length > 32 || !goal || !Number.isInteger(capacity) || capacity < 2 || capacity > 30) {
    send(socket, { type: "error", message: "Enter a room name, a 4-32 character room code, a study goal, and a member limit from 2 to 30." });
    return;
  }
  const key = normalizeRoomKey(name);
  if (roomNames.has(key)) {
    send(socket, { type: "error", message: "That room name is already in use. Join it with its code or choose another name." });
    return;
  }

  const id = crypto.randomUUID();
  const room = {
    id,
    name,
    keyHash: hashKeyCode(keyCode),
    category,
    goal,
    capacity,
    members: new Set(),
    history: []
  };
  rooms.set(id, room);
  roomNames.set(key, id);
  joinRoomRecord(socket, room, message.displayName);
}

function joinRoom(socket, requestedRoom, requestedKeyCode, requestedName) {
  const name = normalizeChannelName(requestedRoom);
  const keyCode = normalizeKeyCode(requestedKeyCode);
  const roomId = roomNames.get(normalizeRoomKey(name));
  const room = roomId ? rooms.get(roomId) : null;
  if (!room || !keyCode || !safeKeyCodeMatch(room.keyHash, keyCode)) {
    send(socket, { type: "error", message: "Room name or code is incorrect." });
    return;
  }
  if (room.members.size >= room.capacity) {
    send(socket, { type: "error", message: "This study room is full." });
    return;
  }
  joinRoomRecord(socket, room, requestedName);
}

function joinRoomRecord(socket, room, requestedName) {
  leaveRoom(socket);
  socket.room = room.id;
  socket.name = normalizeName(requestedName);
  room.members.add(socket);
  const members = [...room.members].map(member => ({ id: member.id, name: member.name }));
  send(socket, {
    type: "joined",
    clientId: socket.id,
    room: { id: room.id, name: room.name, category: room.category, goal: room.goal, capacity: room.capacity },
    history: room.history,
    members
  });
  broadcast(room.id, { type: "presence", members });
}

function leaveRoom(socket) {
  if (!socket.room) return;
  const room = rooms.get(socket.room);
  if (room) {
    room.members.delete(socket);
    broadcast(room.id, { type: "presence", members: [...room.members].map(member => ({ id: member.id, name: member.name })) });
  }
  socket.room = null;
}

function broadcast(room, message, excludedSocket) {
  const members = rooms.get(room)?.members || [];
  for (const member of members) {
    if (member !== excludedSocket) send(member, message);
  }
}

function relayToRoom(room, sender, message) {
  const members = rooms.get(room)?.members || [];
  for (const member of members) {
    if (member !== sender && member.id === message.targetId) send(member, message);
  }
}

function send(socket, message) {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
}

function normalizeChannelName(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 50) : "";
}

function normalizeRoomKey(value) {
  return value.toLocaleLowerCase();
}

function normalizeKeyCode(value) {
  return typeof value === "string" ? value.trim().slice(0, 32) : "";
}

function hashKeyCode(value) {
  return crypto.createHash("sha256").update(value).digest();
}

function safeKeyCodeMatch(expectedHash, value) {
  const actualHash = hashKeyCode(value);
  return crypto.timingSafeEqual(expectedHash, actualHash);
}

function normalizeRoom(value) {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

function normalizeName(value) {
  return (typeof value === "string" && value.trim() ? value.trim() : "Guest").slice(0, 40);
}

server.listen(port, () => {
  console.log(`EAPIHS Assistant server listening on port ${port}`);
});
