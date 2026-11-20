import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NIM_APP_KEY = "3a6a3e48f6854dfa4e4464f3bdaec3b4";
const ENTER_TIMEOUT_MS = 15_000;
const SEND_TIMEOUT_MS = 10_000;

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readString(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function buildEnterInfo(profile) {
  const values = {};
  if (readString(profile.nick)) values.nick = readString(profile.nick);
  if (readString(profile.avatar)) values.avatar = readString(profile.avatar);
  return { values_: values };
}

function buildMessage(text, roomId, messageId, profile) {
  const userId = readString(profile.userId);
  const nick = readString(profile.nick);
  const avatar = readString(profile.avatar);
  const numericUserId = userId && /^\d+$/.test(userId) ? Number(userId) : null;
  const serverExt = numericUserId !== null && nick && avatar
    ? {
        userId: numericUserId,
        nickname: nick,
        avatarUrl: avatar,
        msgId: Number(
          BigInt(`0x${messageId.replaceAll("-", "").slice(0, 12)}`)
            % 90_000_000_000n
            + 10_000_000_000n,
        ),
        ...(typeof profile.gender === "number" ? { gender: profile.gender } : {}),
      }
    : undefined;
  const ext = JSON.stringify({
    ...(serverExt ? { serverExt } : {}),
    appName: "music",
    clientExt: {
      bizType: "listenTogether",
      ltType: "FRIEND",
      roomId,
      clientMsgId: messageId,
    },
  });
  return {
    msg_type_: 0,
    msg_attach_: text,
    msg_body_: "",
    client_msg_id_: messageId,
    sub_type_: 0,
    msg_setting_: {
      ext_: ext,
      anti_spam_enable_: false,
      history_save_: true,
      anti_spam_using_yidun_: 1,
      route_enabled_: true,
    },
  };
}

async function main() {
  const input = asRecord(await readStdin());
  const credentials = asRecord(input.credentials);
  const profile = asRecord(input.profile);
  const roomId = readString(input.roomId);
  const chatRoomId = readString(input.chatRoomId);
  const text = readString(input.text);
  const accId = readString(credentials.accId);
  const token = readString(credentials.token);
  const roomNumber = Number(chatRoomId);
  if (!roomId || !chatRoomId || !Number.isSafeInteger(roomNumber) || roomNumber <= 0) {
    throw new Error("Unsupported NetEase Listen Together room");
  }
  if (!text || text.length > 500) throw new Error("ChatRoom message must be 1-500 characters");
  if (!accId || !token) throw new Error("NetEase realtime credentials are missing");

  const imported = await import("node-nim");
  const nim = imported.default ?? imported;
  if (
    typeof nim.NIMClient !== "function"
    || typeof nim.NIMPlugin !== "function"
    || typeof nim.ChatRoom !== "function"
  ) {
    throw new Error("node-nim runtime exports are unavailable");
  }

  const dataDir = await mkdtemp(join(tmpdir(), "netease-together-"));
  const client = new nim.NIMClient();
  const plugin = new nim.NIMPlugin();
  const chatroom = new nim.ChatRoom();
  const config = {
    database_encrypt_key_: NIM_APP_KEY,
    use_https_: true,
    sdk_log_level_: 2,
  };
  if (!client.init(NIM_APP_KEY, `${dataDir}/`, "", config)) {
    throw new Error("NIM client initialization failed");
  }
  client.initEventHandlers();
  plugin.initEventHandlers();
  if (!chatroom.init("", "")) throw new Error("NIM ChatRoom initialization failed");
  chatroom.initEventHandlers();

  const [loginResult] = await client.login(NIM_APP_KEY, accId, token, null, "");
  const loginCode = readNumber(asRecord(loginResult).res_code_);
  if (loginCode !== 200) throw new Error(`NIM login failed code=${loginCode ?? "unknown"}`);
  const [ticketCode, ticket] = await plugin.chatRoomRequestEnterAsync(roomNumber, null, "");
  if (readNumber(ticketCode) !== 200 || !readString(ticket)) {
    throw new Error(`NIM ChatRoom enter ticket failed code=${readNumber(ticketCode) ?? "unknown"}`);
  }

  const entered = new Promise((resolve, reject) => {
    chatroom.on("enter", (...args) => {
      if (readNumber(args[0]) !== roomNumber || readNumber(args[1]) !== 5) return;
      const code = readNumber(args[2]);
      if (code === 200) resolve();
      else reject(new Error(`NIM ChatRoom auth failed code=${code ?? "unknown"}`));
    });
  });
  if (!chatroom.enter(roomNumber, ticket, buildEnterInfo(profile), "")) {
    throw new Error("NIM ChatRoom enter request was rejected locally");
  }
  await withTimeout(entered, ENTER_TIMEOUT_MS, "NIM ChatRoom enter timed out");

  const nick = readString(profile.nick);
  const avatar = readString(profile.avatar);
  if (nick || avatar) {
    const member = {
      account_id_: accId,
      ...(nick ? { nick_: nick } : {}),
      ...(avatar ? { avatar_: avatar } : {}),
    };
    const [, updateCode] = await chatroom.updateMyRoomRoleAsync(
      roomNumber,
      member,
      false,
      "",
      null,
      "",
    );
    if (readNumber(updateCode) !== 200) {
      throw new Error(`NIM ChatRoom member profile update failed code=${readNumber(updateCode) ?? "unknown"}`);
    }
  }

  const messageId = randomUUID();
  const sent = new Promise((resolve, reject) => {
    chatroom.on("sendMsg", (...args) => {
      if (readNumber(args[0]) !== roomNumber) return;
      const message = asRecord(args[2]);
      if (readString(message.client_msg_id_) !== messageId) return;
      const code = readNumber(args[1]);
      if (code === 200) resolve({ ok: true, messageId, code });
      else reject(new Error(`NIM ChatRoom send failed code=${code ?? "unknown"}`));
    });
  });
  if (!chatroom.sendMsg(roomNumber, buildMessage(text, roomId, messageId, profile), "")) {
    throw new Error("NIM ChatRoom send request was rejected locally");
  }
  return await withTimeout(sent, SEND_TIMEOUT_MS, "NIM ChatRoom send timed out");
}

try {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown Together chat error";
  const definitive = /rejected locally|send failed|not currently|unsupported/i.test(message);
  process.stdout.write(`${JSON.stringify({ ok: false, error: message, definitive })}\n`);
  process.exit(1);
}
