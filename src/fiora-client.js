import WebSocket from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitForFiora } from './md-to-plain.js';

function getFriendId(userId1, userId2) {
  if (userId1 < userId2) return userId1 + userId2;
  return userId2 + userId1;
}

export class FioraClient {
  constructor({ url, apiKey, onEvent, log = console.log }) {
    this.platform = 'fiora';
    this.maxTextLength = 2048; // Fiora 按 String.length 校验文本长度（UTF-16 码元）。
    this.siteUrl = String(url || '').replace(/\/+$/, '');
    this.apiKey = String(apiKey || '').trim();
    this.onEvent = onEvent || (() => {});
    this.log = log;

    this.socket = null;
    this.connected = false;
    this.everConnected = false;
    this.lastConnectError = '';
    this.selfId = '';
    this.selfNickname = '大肥鱼';
    this.selfInfo = null;
    this.allowedGroupIds = [];
    this.allowPrivate = false;
    this.conversationCache = null;
    this.conversationCacheAt = 0;
    this.conversationRequest = null;

    this.statusListeners = new Set();
    this.#closedByUs = false;
    this.#reconnectTimer = null;
    this.#pingTimer = null;
    this.#failedAttempts = 0;
    this.#pendingRequests = new Map(); // requestId -> { resolve, reject, timeout }
  }

  #closedByUs;
  #reconnectTimer;
  #pingTimer;
  #failedAttempts;
  #pendingRequests;

  onStatus(fn) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  #setStatus(connected, error = '') {
    this.connected = connected;
    if (connected) { this.everConnected = true; this.lastConnectError = ''; }
    if (error) this.lastConnectError = error;
    for (const fn of this.statusListeners) {
      try { fn({ connected, everConnected: this.everConnected, error: this.lastConnectError }); } catch {}
    }
  }

  async connect() {
    this.#closedByUs = false;
    if (!this.siteUrl || !this.apiKey) {
      this.log('[Fiora] 未配置 Fiora 站点地址或 API Key（可在控制台 http://127.0.0.1:3220 填写）');
      this.#setStatus(false, '未配置站点地址或 API Key');
      return false;
    }
    return new Promise((resolve) => {
      let resolved = false;
      const onStatus = ({ connected }) => {
        if (connected && !resolved) {
          resolved = true;
          this.statusListeners.delete(onStatus);
          resolve(true);
        }
      };
      this.statusListeners.add(onStatus);
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.statusListeners.delete(onStatus);
          resolve(false);
        }
      }, 10000);
      timer.unref?.();

      this.#openSocket();
    });
  }

  async close() {
    this.#closedByUs = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#reconnectTimer = null;
    this.#pingTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) { try { socket.close(); } catch {} }
    this.#setStatus(false);
  }

  async reconnect() {
    await this.close();
    this.#closedByUs = false;
    this.#failedAttempts = 0;
    this.#openSocket();
  }

  #openSocket() {
    if (this.#closedByUs) return;
    if (this.socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(this.socket.readyState)) return;
    if (!this.siteUrl || !this.apiKey) {
      this.log('[Fiora] 未配置 Fiora 站点地址或 API Key');
      this.#setStatus(false, '未配置站点地址或 API Key');
      return;
    }

    let wsUrl;
    try {
      const u = new URL(this.siteUrl);
      const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${proto}//${u.host}/api/bot/v1/ws?token=${encodeURIComponent(this.apiKey)}`;
    } catch (err) {
      this.log(`[Fiora] 站点地址格式错误: ${this.siteUrl}`);
      this.#setStatus(false, '站点地址格式错误');
      return;
    }

    this.log(`[Fiora] 正在连接 Fiora WebSocket 网关... (${this.siteUrl})`);

    try {
      this.socket = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });
    } catch (err) {
      this.#handleDisconnect(err.message);
      return;
    }

    const socket = this.socket;
    socket.on('open', () => {
      if (this.socket !== socket || this.#closedByUs) return;
      this.#failedAttempts = 0;
      this.log('[Fiora] WebSocket 已建立，等待服务器确认身份和在线状态');

      // Start ping heartbeat
      if (this.#pingTimer) clearInterval(this.#pingTimer);
      this.#pingTimer = setInterval(() => {
        if (this.socket === socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000);
      this.#pingTimer.unref?.();
    });

    socket.on('message', (raw) => {
      if (this.socket !== socket || this.#closedByUs) return;
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!data) return;

      if (data.type === 'ready') {
        this.selfId = data.user?.id || '';
        this.selfNickname = data.user?.name || '大肥鱼';
        this.selfInfo = { user_id: this.selfId, nickname: this.selfNickname };
        this.allowedGroupIds = data.scope?.allowedGroupIds || [];
        this.allowPrivate = !!data.scope?.allowPrivate;
        this.conversationCache = null;
        this.#setStatus(true);
        this.log(`[Fiora] 身份初始化完成: ${this.selfNickname} (${this.selfId})，授权群数: ${this.allowedGroupIds.length}`);
        return;
      }

      if (data.type === 'pong') {
        return;
      }

      if (data.type === 'sent') {
        const pending = this.#pendingRequests.get(data.requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.#pendingRequests.delete(data.requestId);
          pending.resolve(data);
        }
        return;
      }

      if (data.type === 'uploaded') {
        const pending = this.#pendingRequests.get(data.requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          this.#pendingRequests.delete(data.requestId);
          pending.resolve(data);
        }
        return;
      }

      if (data.type === 'error') {
        if (data.requestId) {
          const pending = this.#pendingRequests.get(data.requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            this.#pendingRequests.delete(data.requestId);
            pending.reject(new Error(data.error || '操作失败'));
          }
        }
        return;
      }

      if (data.type === 'message.created') {
        this.#handleIncomingMessage(data.message);
      }
    });

    socket.on('close', (code, reason) => {
      if (this.socket !== socket || this.#closedByUs) return;
      this.#handleDisconnect(`连接关闭 (${code}: ${reason || '未知'})`);
    });

    socket.on('error', (err) => {
      if (this.socket !== socket || this.#closedByUs) return;
      this.#handleDisconnect(err.message || '网络错误');
    });
  }

  #handleDisconnect(reason) {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) { try { socket.terminate(); } catch {} }
    this.#setStatus(false, reason);
    if (this.#closedByUs) return;

    this.#failedAttempts++;
    const delayMs = Math.min(30000, 2000 * Math.pow(1.5, Math.min(this.#failedAttempts, 6)));
    this.log(`[Fiora] 连接断开 (${reason})，将于 ${Math.round(delayMs / 1000)} 秒后自动重试...`);

    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#openSocket();
    }, delayMs);
  }

  #toFullUrl(pathStr) {
    if (!pathStr) return '';
    const str = String(pathStr).trim();
    if (str.startsWith('http://') || str.startsWith('https://')) return str;
    if (str.startsWith('//')) {
      const proto = this.siteUrl.startsWith('https:') ? 'https:' : 'http:';
      return `${proto}${str}`;
    }
    const base = this.siteUrl.replace(/\/+$/, '');
    const cleanPath = str.startsWith('/') ? str : `/${str}`;
    return `${base}${cleanPath}`;
  }

  #handleIncomingMessage(msg) {
    if (!msg || !msg.id || !msg.conversationId) return;
    // Filter out our own messages
    if (msg.user?.id && String(msg.user.id) === String(this.selfId)) return;

    const convId = String(msg.conversationId);
    const isGroup = convId.length !== 48 || this.allowedGroupIds.includes(convId);
    const senderId = String(msg.user?.id || '');
    const senderName = String(msg.user?.name || senderId || '未知群友');
    const content = String(msg.content || '').trim();
    const msgType = String(msg.type || 'text');

    const event = {
      post_type: 'message',
      message_type: isGroup ? 'group' : 'private',
      group_id: isGroup ? convId : undefined,
      user_id: senderId,
      message_id: msg.id,
      sender: {
        user_id: senderId,
        nickname: senderName,
        card: senderName,
      },
      time: Math.floor(new Date(msg.createdAt || Date.now()).getTime() / 1000),
      raw_message: '',
      message: [],
    };

    if (msgType === 'image') {
      const fullUrl = this.#toFullUrl(content);
      event.raw_message = `[CQ:image,file=${fullUrl},url=${fullUrl}]`;
      event.message = [
        {
          type: 'image',
          data: {
            file: fullUrl,
            url: fullUrl,
            summary: '图片',
          },
        },
      ];
    } else if (msgType === 'file') {
      let fileName = '文件';
      let fileSize = 0;
      try {
        const fileObj = JSON.parse(content);
        fileName = fileObj.name || fileName;
        fileSize = fileObj.size || fileSize;
      } catch {}
      event.raw_message = `[文件: ${fileName}]`;
      event.message = [
        {
          type: 'file',
          data: { name: fileName, size: fileSize },
        },
      ];
    } else {
      // Normal text or code
      event.raw_message = content;
      event.message = [
        {
          type: 'text',
          data: { text: content },
        },
      ];

      // If text mentions @大肥鱼 or aliases, synthesize an at segment
      const escapedNick = (this.selfNickname || '大肥鱼').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const atPattern = new RegExp(`@(?:${escapedNick}|大肥鱼|小鲸鱼|肥鱼)`, 'i');
      if (atPattern.test(content)) {
        event.message.unshift({
          type: 'at',
          data: { qq: this.selfId, text: `@${this.selfNickname}` },
        });
      }
    }

    try {
      this.onEvent(event);
    } catch (err) {
      this.log(`[Fiora] 处理接收消息出错: ${err.message}`);
    }
  }

  /**
   * 上传本地/网络/Base64 图片到 Fiora 服务器，返回 /ImageMessage/... 路径
   */
  async uploadImage(fileRef) {
    if (!fileRef) throw new Error('未提供图片文件');

    let raw = fileRef;
    if (typeof raw === 'object' && raw.file) raw = raw.file;
    if (typeof raw === 'object' && raw.url) raw = raw.url;

    // If already on Fiora or OSS
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (/^\/?ImageMessage\//.test(trimmed)) {
        return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
      }
    }

    let buffer;
    let fileName = 'image.png';

    if (Buffer.isBuffer(raw)) {
      buffer = raw;
    } else if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.startsWith('data:image/')) {
        const commaIdx = trimmed.indexOf(',');
        const meta = trimmed.slice(0, commaIdx);
        const match = meta.match(/data:image\/([a-zA-Z0-9]+);base64/);
        const ext = match ? match[1].toLowerCase() : 'png';
        fileName = `image.${ext === 'jpeg' ? 'jpg' : ext}`;
        buffer = Buffer.from(trimmed.slice(commaIdx + 1), 'base64');
      } else if (trimmed.startsWith('base64://')) {
        buffer = Buffer.from(trimmed.slice(9), 'base64');
      } else if (trimmed.startsWith('file://')) {
        try {
          const localPath = fileURLToPath(trimmed);
          fileName = path.basename(localPath) || 'image.png';
          buffer = await fs.promises.readFile(localPath);
        } catch {
          const localPath = trimmed.replace(/^file:\/\/\/?/, '');
          fileName = path.basename(localPath) || 'image.png';
          buffer = await fs.promises.readFile(decodeURIComponent(localPath));
        }
      } else if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/') || fs.existsSync(trimmed)) {
        fileName = path.basename(trimmed) || 'image.png';
        buffer = await fs.promises.readFile(trimmed);
      } else if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        try {
          const u = new URL(trimmed);
          if (u.pathname.startsWith('/ImageMessage/')) {
            return u.pathname;
          }
        } catch {}
        fileName = path.basename(new URL(trimmed).pathname) || 'image.png';
        const res = await fetch(trimmed);
        if (!res.ok) throw new Error(`下载外部图片失败: HTTP ${res.status}`);
        buffer = Buffer.from(await res.arrayBuffer());
      } else {
        try {
          buffer = Buffer.from(trimmed, 'base64');
        } catch {
          throw new Error(`无法识别图片路径: ${trimmed}`);
        }
      }
    } else {
      throw new Error('不支持的图片类型');
    }

    if (!buffer || buffer.length === 0) {
      throw new Error('图片数据为空');
    }

    let ext = (path.extname(fileName) || '').replace(/^\./, '').toLowerCase();
    if (!['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
      if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) ext = 'jpg';
      else if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ext = 'png';
      else if (['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) ext = 'gif';
      else if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') ext = 'webp';
      else ext = 'png';
      fileName = `image.${ext}`;
    }

    // Try WebSocket upload first
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      const requestId = crypto.randomUUID();
      try {
        const result = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.#pendingRequests.delete(requestId);
            reject(new Error('上传图片超时'));
          }, 30000);
          this.#pendingRequests.set(requestId, {
            resolve: (data) => resolve(data.url),
            reject,
            timeout,
          });
          this.socket.send(JSON.stringify({
            action: 'upload_image',
            file: buffer.toString('base64'),
            fileName,
            requestId,
          }));
        });
        return result;
      } catch (wsErr) {
        this.log(`[Fiora] WS 上传未完成 (${wsErr.message})，回退 HTTP 上传`);
      }
    }

    // Fallback: HTTP POST
    const uploadUrl = `${this.siteUrl}/api/bot/v1/images`;
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ file: buffer.toString('base64'), fileName }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status} 上传图片失败`);
    }
    const data = await res.json();
    return data.url;
  }

  /**
   * 发送消息段（OneBot 适配层）
   */
  async sendSegments(kind, id, segments) {
    if (!Array.isArray(segments) || !segments.length) return { message_id: '' };

    const hasImage = segments.some((s) => s?.type === 'image' || s?.type === 'sticker');
    if (!hasImage) {
      const text = this.#extractText(segments);
      if (!text) return { message_id: '' };
      return kind === 'private' ? this.sendPrivateMsg(id, text) : this.sendGroupMsg(id, text);
    }

    let lastResult = { message_id: '' };
    let currentText = '';

    for (const seg of segments) {
      if (seg.type === 'text') {
        currentText += seg.data?.text ?? '';
      } else if (seg.type === 'at') {
        currentText += `@${seg.data?.qq ?? ''} `;
      } else if (seg.type === 'image' || seg.type === 'sticker') {
        if (currentText.trim()) {
          lastResult = await (kind === 'private' ? this.sendPrivateMsg(id, currentText.trim()) : this.sendGroupMsg(id, currentText.trim()));
          currentText = '';
        }
        const fileRef = seg.data?.file || seg.data?.url;
        if (fileRef) {
          lastResult = await this.sendImage(kind, id, fileRef);
        }
      }
    }
    if (currentText.trim()) {
      lastResult = await (kind === 'private' ? this.sendPrivateMsg(id, currentText.trim()) : this.sendGroupMsg(id, currentText.trim()));
    }
    return lastResult;
  }

  /**
   * 发送纯文本消息（OneBot 适配层）
   */
  async sendText(kind, id, text, { replyToMessageId = null, atUserId = null } = {}) {
    let content = String(text ?? '');
    if (kind === 'private') {
      return this.sendPrivateMsg(id, content);
    }
    return this.sendGroupMsg(id, content);
  }

  /**
   * 发送表情（OneBot 适配层）
   */
  async sendSticker(kind, id, imageUrl, { replyToMessageId = null, atUserId = null } = {}) {
    return this.sendImage(kind, id, imageUrl, { replyToMessageId, atUserId });
  }

  /**
   * 发送图片（OneBot 适配层，自动上传到 Fiora 并作为图片气泡呈现）
   */
  async sendImage(kind, id, fileRef, { replyToMessageId = null, atUserId = null } = {}) {
    try {
      const rawRef = typeof fileRef === 'object' && fileRef?.file ? fileRef.file : fileRef;
      const conversationId = kind === 'private'
        ? (id.length === 48 ? id : getFriendId(this.selfId, id))
        : id;
      const fioraUrl = await this.uploadImage(rawRef);
      return this.sendRaw(conversationId, fioraUrl, 'image');
    } catch (err) {
      this.log(`[Fiora] 发送图片失败: ${err.message}`);
      throw err;
    }
  }

  /**
   * 戳一戳（OneBot 适配层）
   */
  async sendPoke(kind, id, targetUserId) {
    const content = '[拍了拍]';
    if (kind === 'private') return this.sendPrivateMsg(id, content);
    return this.sendGroupMsg(id, content);
  }

  /**
   * 获取群信息（OneBot 适配层）
   */
  async getGroupInfo(groupId) {
    return { group_id: String(groupId), group_name: await this.getChatName('group', groupId) };
  }

  async getConversations() {
    if (this.conversationCache && Date.now() - this.conversationCacheAt < 30000) {
      return this.conversationCache;
    }
    if (this.conversationRequest) return this.conversationRequest;
    this.conversationRequest = (async () => {
      const res = await fetch(`${this.siteUrl}/api/bot/v1/conversations`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`获取 Fiora 会话失败: HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data.conversations)) throw new Error('Fiora 会话列表格式错误');
      this.conversationCache = data.conversations;
      this.conversationCacheAt = Date.now();
      return data.conversations;
    })();
    try { return await this.conversationRequest; }
    finally { this.conversationRequest = null; }
  }

  privatePeerId(conversationId) {
    const id = String(conversationId);
    if (this.selfId && id.length === this.selfId.length * 2) {
      if (id.startsWith(this.selfId)) return id.slice(this.selfId.length);
      if (id.endsWith(this.selfId)) return id.slice(0, -this.selfId.length);
    }
    return id;
  }

  async getChatName(kind, id) {
    const conversations = await this.getConversations();
    const item = conversations.find((c) => c.type === kind &&
      (String(c.id) === String(id) || (kind === 'private' && this.privatePeerId(c.id) === String(id))));
    return item ? String(item.name || '') : '';
  }

  /**
   * 发送群消息
   */
  async sendGroupMsg(groupId, message) {
    if (Array.isArray(message)) {
      return this.sendSegments('group', groupId, message);
    }
    if (message && typeof message === 'object') {
      if (message.type === 'image' || message.type === 'sticker') {
        return this.sendImage('group', groupId, message.data?.file || message.data?.url);
      }
    }
    const text = typeof message === 'string' ? message : this.#extractText(message);
    if (!text) return { message_id: '' };

    const cqMatch = text.match(/^\[CQ:image,file=([^,\]]+).*?\]$/i);
    if (cqMatch) {
      return this.sendImage('group', groupId, cqMatch[1]);
    }

    return this.sendRaw(groupId, text, 'text');
  }

  /**
   * 发送私聊消息
   */
  async sendPrivateMsg(userId, message) {
    if (Array.isArray(message)) {
      return this.sendSegments('private', userId, message);
    }
    if (message && typeof message === 'object') {
      if (message.type === 'image' || message.type === 'sticker') {
        return this.sendImage('private', userId, message.data?.file || message.data?.url);
      }
    }
    const text = typeof message === 'string' ? message : this.#extractText(message);
    if (!text) return { message_id: '' };

    const cqMatch = text.match(/^\[CQ:image,file=([^,\]]+).*?\]$/i);
    if (cqMatch) {
      return this.sendImage('private', userId, cqMatch[1]);
    }

    const conversationId = userId.length === 48 ? userId : getFriendId(this.selfId, userId);
    return this.sendRaw(conversationId, text, 'text');
  }

  /** 供发送队列与直接调用共用的 Fiora 文本分段规则。 */
  splitText(content, max = this.maxTextLength) {
    return splitForFiora(content, Math.min(max, this.maxTextLength));
  }

  /** 基础消息发送：通过 WebSocket 实时上报（网络异常时带 HTTP 回退）。 */
  async sendRaw(conversationId, content, type = 'text') {
    const parts = type === 'text' ? this.splitText(content) : [content];
    if (parts.length <= 1) return this.#sendRawMessage(conversationId, parts[0] ?? '', type);

    const sent = [];
    for (const part of parts) {
      try {
        const receipt = await this.#sendRawMessage(conversationId, part, type);
        sent.push({ content: part, message_id: receipt.message_id });
      } catch (error) {
        // 已成功的分段保留回执；停止后续发送，不自动重发整段造成重复。
        error.sent = sent;
        throw error;
      }
    }
    return { message_id: sent.at(-1).message_id, sent };
  }

  async #sendRawMessage(conversationId, content, type) {
    const requestId = crypto.randomUUID();

    if (!this.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      // Fallback to HTTP POST if WebSocket is briefly reconnecting
      return this.#sendViaHttp(conversationId, content, requestId, type);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingRequests.delete(requestId);
        // Timeout over WS, try HTTP fallback
        this.#sendViaHttp(conversationId, content, requestId, type).then(resolve).catch(reject);
      }, 15000);

      this.#pendingRequests.set(requestId, {
        resolve: (data) => resolve({ message_id: data.id }),
        reject,
        timeout,
      });

      this.socket.send(JSON.stringify({
        action: 'send',
        conversationId,
        content,
        type,
        requestId,
      }));
    });
  }

  async #sendViaHttp(conversationId, content, requestId, type = 'text') {
    const url = `${this.siteUrl}/api/bot/v1/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ conversationId, content, type, requestId }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    return { message_id: data.id };
  }

  #extractText(message) {
    if (typeof message === 'string') return message.trim();
    if (Array.isArray(message)) {
      return message
        .map((seg) => {
          if (typeof seg === 'string') return seg;
          if (seg.type === 'text') return seg.data?.text ?? '';
          if (seg.type === 'image') return seg.data?.file ?? '[图片]';
          if (seg.type === 'at') return seg.data?.qq ? `@${seg.data.qq} ` : '';
          return '';
        })
        .join('')
        .trim();
    }
    if (message && typeof message === 'object') {
      if (message.type === 'text') return String(message.data?.text || '').trim();
      if (message.type === 'image') return String(message.data?.file || '[图片]').trim();
    }
    return String(message || '').trim();
  }

  // 兼容 QQ-agent 常用 OneBot API 调用
  async call(action, params = {}) {
    if (action === 'get_login_info') {
      return this.selfInfo || { user_id: this.selfId, nickname: this.selfNickname };
    }
    if (action === 'send_group_msg') {
      return this.sendGroupMsg(params.group_id, params.message);
    }
    if (action === 'send_private_msg') {
      return this.sendPrivateMsg(params.user_id, params.message);
    }
    if (action === 'get_group_member_info') {
      return this.getGroupMemberInfo(params.group_id, params.user_id);
    }
    if (action === 'get_group_member_list') {
      return this.getGroupMemberList(params.group_id);
    }
    if (action === 'get_group_info') {
      return this.getGroupInfo(params.group_id);
    }
    if (action === 'get_group_list') {
      return (await this.getConversations()).filter((c) => c.type === 'group')
        .map((c) => ({ group_id: String(c.id), group_name: String(c.name || c.id) }));
    }
    if (action === 'get_friend_list') {
      return (await this.getConversations()).filter((c) => c.type === 'private')
        .map((c) => ({ user_id: this.privatePeerId(c.id), nickname: String(c.name || c.id) }));
    }
    if (action === 'get_msg') {
      return this.getMsg(params.message_id);
    }
    if (action === 'get_image') {
      const fullUrl = this.#toFullUrl(params.file);
      return { file: fullUrl, url: fullUrl };
    }
    return {};
  }

  async getGroupMemberInfo(groupId, userId) {
    const members = await this.getGroupMemberList(groupId);
    return members.find((m) => m.user_id === userId) || { user_id: userId, nickname: '群友', card: '群友' };
  }

  async getGroupMemberList(groupId) {
    const members = [];
    const visited = new Set();
    let after = '';
    do {
      const query = new URLSearchParams({ conversationId: String(groupId), limit: '100' });
      if (after) query.set('after', after);
      const url = `${this.siteUrl}/api/bot/v1/members?${query}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`获取 Fiora 成员失败: HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data.members)) throw new Error('Fiora 成员列表格式错误');
      members.push(...data.members.map((m) => ({
        user_id: String(m.id),
        nickname: m.name,
        card: m.name,
        avatar: m.avatar || '',
      })));
      after = data.next ? String(data.next) : '';
      if (after && visited.has(after)) throw new Error('Fiora 成员分页游标重复');
      if (after) visited.add(after);
    } while (after);
    return members;
  }

  async getMsg(messageId) {
    try {
      const url = `${this.siteUrl}/api/bot/v1/messages/${messageId}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) return null;
      const data = await res.json();
      const m = data.message;
      return {
        message_id: m.id,
        sender: { user_id: m.user?.id, nickname: m.user?.name, card: m.user?.name },
        message: m.content,
      };
    } catch {
      return null;
    }
  }
}
