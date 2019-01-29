import {
  ICryptoLib,
  IEncryptionPayload,
  ISocketMessage,
  ISessionStatus,
  ISessionError,
  IInternalEvent,
  IJsonRpcResponse,
  IPartialRpcResponse,
  IPartialRpcRequest,
  IJsonRpcRequest,
  ITxData,
  IClientMeta,
  IEventEmitter,
  IParseURIResult,
  ISessionParams,
  IWalletConnectSession,
  IWalletConnectOptions
} from "./types";
import {
  convertArrayBufferToHex,
  convertHexToArrayBuffer,
  getMeta,
  payloadId,
  uuid,
  parseWalletConnectUri
} from "./utils";

// -- typeChecks ----------------------------------------------------------- //

function isRpcRequest(object: any): object is IJsonRpcRequest {
  return "method" in object;
}

function isRpcResponse(object: any): object is IJsonRpcResponse {
  return "result" in object;
}

function isInternalEvent(object: any): object is IInternalEvent {
  return "event" in object;
}

function isWalletConnectSession(object: any): object is IWalletConnectSession {
  return "bridge" in object;
}

// -- localStorage --------------------------------------------------------- //

const storageId: string = "walletconnect";
let storage: Storage | null = null;

if (
  typeof window !== "undefined" &&
  typeof window.localStorage !== "undefined"
) {
  storage = window.localStorage;
}

// -- Connector ------------------------------------------------------------ //

class Connector {
  private cryptoLib: ICryptoLib;

  private protocol: string;
  private version: number;

  private _bridge: string;
  private _key: ArrayBuffer | null;
  private _nextKey: ArrayBuffer | null;

  private _clientId: string;
  private _clientMeta: IClientMeta | null;
  private _peerId: string;
  private _peerMeta: IClientMeta | null;
  private _handshakeId: number;
  private _handshakeTopic: string;
  private _accounts: string[];
  private _chainId: number;
  private _socket: WebSocket | null;
  private _queue: ISocketMessage[];
  private _eventEmitters: IEventEmitter[];
  private _connected: boolean;

  // -- constructor ----------------------------------------------------- //

  constructor(
    cryptoLib: ICryptoLib,
    opts: IWalletConnectOptions,
    clientMeta?: IClientMeta
  ) {
    this.cryptoLib = cryptoLib;

    this.protocol = "wc";
    this.version = 1;

    this._bridge = "";
    this._key = null;
    this._nextKey = null;

    this._clientId = "";
    this._clientMeta = null;
    this._peerId = "";
    this._peerMeta = null;
    this._handshakeId = 0;
    this._handshakeTopic = "";
    this._accounts = [];
    this._chainId = 0;
    this._socket = null;
    this._queue = [];
    this._eventEmitters = [];
    this._connected = false;

    if (clientMeta) {
      this.clientMeta = clientMeta;
    }

    if (!opts.bridge && !opts.uri && !opts.session) {
      throw new Error(
        "Missing one of two required parameters: bridge / uri / session"
      );
    }

    if (opts.bridge) {
      this.bridge = opts.bridge;
    }

    if (opts.uri) {
      this.uri = opts.uri;
      this._subscribeToSessionRequest();
    }

    const session = opts.session || this._getStorageSession();
    if (session) {
      this.session = session;
      this._exchangeKey();
    }

    if (this.handshakeId) {
      this._subscribeToSessionResponse(
        this.handshakeId,
        "Session request rejected"
      );
    }

    this._subscribeToInternalEvents();
    this._socketOpen();
  }

  // -- setters / getters ----------------------------------------------- //

  set bridge(value: string) {
    if (!value) {
      return;
    }
    this._bridge = value;
  }

  get bridge() {
    return this._bridge;
  }

  set key(value: string) {
    if (!value) {
      return;
    }
    const key: ArrayBuffer = convertHexToArrayBuffer(value);
    this._key = key;
  }

  get key(): string {
    if (this._key) {
      const key: string = convertArrayBufferToHex(this._key);
      return key;
    }
    return "";
  }

  set nextKey(value: string) {
    if (!value) {
      return;
    }
    const nextKey: ArrayBuffer = convertHexToArrayBuffer(value);
    this._nextKey = nextKey;
  }

  get nextKey(): string {
    if (this._nextKey) {
      const nextKey: string = convertArrayBufferToHex(this._nextKey);
      return nextKey;
    }
    return "";
  }

  set clientId(value: string) {
    if (!value) {
      return;
    }
    this._clientId = value;
  }

  get clientId() {
    let clientId: string | null = this._clientId;
    if (!clientId) {
      clientId = this._clientId = uuid();
    }

    return this._clientId;
  }

  set peerId(value) {
    if (!value) {
      return;
    }
    this._peerId = value;
  }

  get peerId() {
    return this._peerId;
  }

  set clientMeta(value) {
    return;
  }

  get clientMeta() {
    let clientMeta: IClientMeta | null = this._clientMeta;
    if (!clientMeta) {
      clientMeta = this._clientMeta = getMeta();
    }
    return clientMeta;
  }

  set peerMeta(value) {
    this._peerMeta = value;
  }

  get peerMeta() {
    const peerMeta: IClientMeta | null = this._peerMeta;
    return peerMeta;
  }

  set handshakeTopic(value) {
    if (!value) {
      return;
    }
    this._handshakeTopic = value;
  }

  get handshakeTopic() {
    return this._handshakeTopic;
  }

  set handshakeId(value) {
    if (!value) {
      return;
    }
    this._handshakeId = value;
  }

  get handshakeId() {
    return this._handshakeId;
  }

  get uri() {
    const _uri = this._formatUri();
    return _uri;
  }

  set uri(value) {
    if (!value) {
      return;
    }
    const { handshakeTopic, bridge, key } = this._parseUri(value);
    this.handshakeTopic = handshakeTopic;
    this.bridge = bridge;
    this.key = key;
  }

  set chainId(value) {
    this._chainId = value;
  }

  get chainId() {
    const chainId: number | null = this._chainId;
    return chainId;
  }

  set accounts(value) {
    this._accounts = value;
  }

  get accounts() {
    const accounts: string[] | null = this._accounts;
    return accounts;
  }

  set connected(value) {
    return;
  }

  get connected() {
    return this._connected;
  }

  set pending(value) {
    return;
  }

  get pending() {
    return !!this._handshakeTopic;
  }

  get session() {
    return {
      connected: this.connected,
      accounts: this.accounts,
      chainId: this.chainId,
      bridge: this.bridge,
      key: this.key,
      clientId: this.clientId,
      clientMeta: this.clientMeta,
      peerId: this.peerId,
      peerMeta: this.peerMeta,
      handshakeId: this.handshakeId,
      handshakeTopic: this.handshakeTopic
    };
  }

  set session(value) {
    if (!value) {
      return;
    }
    this._connected = value.connected;
    this.accounts = value.accounts;
    this.chainId = value.chainId;
    this.bridge = value.bridge;
    this.key = value.key;
    this.clientId = value.clientId;
    this.clientMeta = value.clientMeta;
    this.peerId = value.peerId;
    this.peerMeta = value.peerMeta;
    this.handshakeId = value.handshakeId;
    this.handshakeTopic = value.handshakeTopic;
  }

  // -- public ---------------------------------------------------------- //

  public on(
    event: string,
    callback: (error: Error | null, payload: any | null) => void
  ): void {
    const eventEmitter = {
      event,
      callback
    };
    this._eventEmitters.push(eventEmitter);
  }

  public async createSession(): Promise<void> {
    if (this._connected) {
      throw new Error("Session currently connected");
    }

    if (this.pending) {
      return;
    }

    this._key = await this._generateKey();

    const request: IJsonRpcRequest = this._formatRequest({
      method: "wc_sessionRequest",
      params: [
        {
          peerId: this.clientId,
          peerMeta: this.clientMeta
        }
      ]
    });

    this.handshakeId = request.id;
    this.handshakeTopic = uuid();

    this._sendSessionRequest(
      request,
      "Session update rejected",
      this.handshakeTopic
    );
    this._setStorageSession();
  }

  public approveSession(sessionStatus: ISessionStatus) {
    if (this._connected) {
      throw new Error("Session currently connected");
    }

    this.chainId = sessionStatus.chainId;
    this.accounts = sessionStatus.accounts;

    const sessionParams: ISessionParams = {
      approved: true,
      chainId: this.chainId,
      accounts: this.accounts,
      message: null
    };

    const response = {
      id: this.handshakeId,
      jsonrpc: "2.0",
      result: sessionParams
    };

    this._sendResponse(response);

    this._connected = true;
    this._triggerEvents({
      event: "connect",
      params: [
        {
          peerId: this.peerId,
          peerMeta: this.peerMeta,
          chainId: this.chainId,
          accounts: this.accounts
        }
      ]
    });
    this._setStorageSession();
  }

  public rejectSession(sessionError?: ISessionError) {
    if (this._connected) {
      throw new Error("Session currently connected");
    }

    const message = sessionError ? sessionError.message : null;

    const sessionParams: ISessionParams = {
      approved: false,
      chainId: null,
      accounts: null,
      message
    };

    const response = {
      id: this.handshakeId,
      jsonrpc: "2.0",
      result: sessionParams
    };

    this._sendResponse(response);

    this._connected = false;
    this._triggerEvents({
      event: "disconnect",
      params: [{ message }]
    });
    this._removeStorageSession();
  }

  public updateSession(sessionStatus: ISessionStatus) {
    if (!this._connected) {
      throw new Error("Session currently disconnected");
    }

    this.chainId = sessionStatus.chainId;
    this.accounts = sessionStatus.accounts;

    const sessionParams: ISessionParams = {
      approved: true,
      chainId: this.chainId,
      accounts: this.accounts,
      message: null
    };

    const request = this._formatRequest({
      method: "wc_sessionUpdate",
      params: [sessionParams]
    });

    this._sendSessionRequest(request, "Session update rejected");

    this._triggerEvents({
      event: "session_update",
      params: [
        {
          chainId: this.chainId,
          accounts: this.accounts
        }
      ]
    });
    this._setStorageSession();
  }

  public killSession(sessionError?: ISessionError) {
    if (!this._connected) {
      throw new Error("Session currently disconnected");
    }

    const message = sessionError ? sessionError.message : null;

    const sessionParams: ISessionParams = {
      approved: false,
      chainId: null,
      accounts: null,
      message
    };

    const request = this._formatRequest({
      method: "wc_sessionUpdate",
      params: [sessionParams]
    });

    this._sendSessionRequest(request, "Session kill rejected");

    this._connected = false;

    this._triggerEvents({
      event: "disconnect",
      params: [{ message }]
    });

    this._removeStorageSession();
  }

  public async sendTransaction(tx: ITxData) {
    if (!this._connected) {
      throw new Error("Session currently disconnected");
    }

    const request = this._formatRequest({
      method: "eth_sendTransaction",
      params: [tx]
    });

    try {
      const result = await this._sendCallRequest(request);
      return result;
    } catch (error) {
      throw error;
    }
  }

  public async signMessage(params: any[]) {
    if (!this._connected) {
      throw new Error("Session currently disconnected");
    }

    const request = this._formatRequest({
      method: "eth_sign",
      params
    });

    try {
      const result = await this._sendCallRequest(request);
      return result;
    } catch (error) {
      throw error;
    }
  }

  public async signTypedData(params: any[]) {
    if (!this._connected) {
      throw new Error("Session currently disconnected");
    }

    const request = this._formatRequest({
      method: "eth_signTypedData",
      params
    });

    try {
      const result = await this._sendCallRequest(request);
      return result;
    } catch (error) {
      throw error;
    }
  }

  public approveRequest(response: IPartialRpcResponse) {
    const formattedResponse: IJsonRpcResponse = this._formatResponse(response);
    this._sendResponse(formattedResponse);
  }

  public rejectRequest(response: IPartialRpcResponse) {
    const formattedResponse: IJsonRpcResponse = this._formatResponse(response);
    this._sendResponse(formattedResponse);
  }

  // -- private --------------------------------------------------------- //

  private async _sendRequest(request: IPartialRpcRequest, _topic?: string) {
    const callRequest: IJsonRpcRequest = this._formatRequest(request);

    const encryptionPayload: IEncryptionPayload | null = await this._encrypt(
      callRequest
    );

    const topic: string = _topic || this.peerId;
    const payload: string = JSON.stringify(encryptionPayload);

    const socketMessage: ISocketMessage = {
      topic,
      type: "pub",
      payload
    };

    if (this._socket) {
      this._socketSend(socketMessage);
    } else {
      this._setToQueue(socketMessage);
    }
  }

  private async _sendResponse(response: IJsonRpcResponse) {
    const encryptionPayload: IEncryptionPayload | null = await this._encrypt(
      response
    );

    const topic: string = this.peerId;
    const payload: string = JSON.stringify(encryptionPayload);

    const socketMessage: ISocketMessage = {
      topic,
      type: "pub",
      payload
    };

    if (this._socket) {
      this._socketSend(socketMessage);
    } else {
      this._setToQueue(socketMessage);
    }
  }

  private async _sendSessionRequest(
    request: IJsonRpcRequest,
    errorMsg: string,
    _topic?: string
  ) {
    this._sendRequest(request, _topic);
    this._subscribeToSessionResponse(request.id, errorMsg);
  }

  private _sendCallRequest(request: IJsonRpcRequest): Promise<any> {
    this._sendRequest(request);
    return this._subscribeToCallResponse(request.id);
  }

  private _formatRequest(request: IPartialRpcRequest): IJsonRpcRequest {
    const formattedRequest: IJsonRpcRequest = {
      id: payloadId(),
      jsonrpc: "2.0",
      ...request
    };
    return formattedRequest;
  }

  private _formatResponse(response: IPartialRpcResponse): IJsonRpcResponse {
    const formattedResponse: IJsonRpcResponse = {
      jsonrpc: "2.0",
      ...response
    };
    return formattedResponse;
  }

  private _handleSessionResponse(
    sessionParams: ISessionParams,
    errorMsg: string
  ) {
    if (sessionParams.approved) {
      if (!this._connected) {
        this._connected = true;
        if (sessionParams.chainId) {
          this.chainId = sessionParams.chainId;
        }
        if (sessionParams.accounts) {
          this.accounts = sessionParams.accounts;
        }

        this._triggerEvents({
          event: "connect",
          params: [
            {
              peerId: this.peerId,
              peerMeta: this.peerMeta,
              chainId: this.chainId,
              accounts: this.accounts
            }
          ]
        });
      } else {
        if (sessionParams.chainId) {
          this.chainId = sessionParams.chainId;
        }
        if (sessionParams.accounts) {
          this.accounts = sessionParams.accounts;
        }

        this._triggerEvents({
          event: "session_update",
          params: [
            {
              chainId: this.chainId,
              accounts: this.accounts
            }
          ]
        });
      }
      this._setStorageSession();
    } else {
      this._connected = false;
      const message = sessionParams.message || errorMsg;
      this._triggerEvents({
        event: "disconnect",
        params: [{ message }]
      });
      console.error(message); // tslint:disable-line
      this._removeStorageSession();
    }
  }

  private _subscribeToSessionRequest() {
    this._setToQueue({
      topic: `${this.handshakeTopic}`,
      type: "sub",
      payload: ""
    });
  }

  private _subscribeToSessionResponse(id: number, errorMsg: string) {
    this.on(`response:${id}`, (error, payload) => {
      if (error) {
        console.error(errorMsg); // tslint:disable-line
      }

      this._handleSessionResponse(payload.result, errorMsg);
    });
  }

  private _subscribeToCallResponse(id: number): Promise<any> {
    return new Promise((resolve, reject) => {
      this.on(`response:${id}`, (error, payload) => {
        if (error) {
          reject(error);
        }
        if (payload.result) {
          resolve(payload.result);
        } else {
          reject(new Error("Invalid JSON RPC response format received"));
        }
      });
    });
  }

  private _subscribeToInternalEvents() {
    this.on("wc_sessionRequest", (error, payload) => {
      if (error) {
        console.error(error); // tslint:disable-line
      }
      this.handshakeId = payload.id;
      this.peerId = payload.params[0].peerId;
      this.peerMeta = payload.params[0].peerMeta;

      this._exchangeKey();
    });

    this.on("wc_sessionUpdate", (error, payload) => {
      if (error) {
        console.error(error); // tslint:disable-line
      }
      this._handleSessionResponse(payload.params[0], "Session disconnected");
    });

    this.on("wc_exchangeKey", (error, payload) => {
      if (error) {
        console.error(error); // tslint:disable-line
      }
      this._handleExchangeKeyRequest(payload);
    });
  }

  private _triggerEvents(
    payload: IJsonRpcRequest | IJsonRpcResponse | IInternalEvent
  ): void {
    let eventEmitters: IEventEmitter[] = [];
    let event: string;

    if (isRpcRequest(payload)) {
      event = payload.method;
    } else if (isRpcResponse(payload)) {
      event = `response:${payload.id}`;
    } else if (isInternalEvent(payload)) {
      event = payload.event;
    } else {
      event = "";
    }

    if (event) {
      eventEmitters = this._eventEmitters.filter(
        (eventEmitter: IEventEmitter) => eventEmitter.event === event
      );
    }

    if (!eventEmitters || !eventEmitters.length) {
      eventEmitters = this._eventEmitters.filter(
        (eventEmitter: IEventEmitter) => eventEmitter.event === "call_request"
      );
    }

    eventEmitters.forEach((eventEmitter: IEventEmitter) =>
      eventEmitter.callback(null, payload)
    );
  }

  // -- keyManager ------------------------------------------------------- //

  private async _exchangeKey() {
    this._nextKey = await this._generateKey();

    const request: IJsonRpcRequest = this._formatRequest({
      method: "wc_exchangeKey",
      params: [
        {
          peerId: this.clientId,
          peerMeta: this.clientMeta,
          nextKey: this.nextKey
        }
      ]
    });

    try {
      await this._sendCallRequest(request);
      this._swapKey();
    } catch (error) {
      throw error;
    }
  }

  private async _handleExchangeKeyRequest(payload: IJsonRpcRequest) {
    const { peerId, peerMeta, nextKey } = payload.params[0];
    this.peerId = peerId;
    this.peerMeta = peerMeta;
    this.nextKey = nextKey;
    const response = {
      id: payload.id,
      jsonrpc: "2.0",
      result: true
    };
    await this._sendResponse(response);
    this._swapKey();
  }

  private _swapKey() {
    this._key = this._nextKey;
    this._nextKey = null;
    this._setStorageSession();
  }

  // -- websocket ------------------------------------------------------- //

  private _socketOpen() {
    const bridge = this.bridge;

    const url = bridge.startsWith("https")
      ? bridge.replace("https", "wss")
      : bridge.startsWith("http")
      ? bridge.replace("http", "ws")
      : bridge;

    const socket = new WebSocket(url);

    socket.onmessage = (event: MessageEvent) => this._socketReceive(event);

    socket.onopen = () => {
      this._socket = socket;

      this._setToQueue({
        topic: `${this.clientId}`,
        type: "sub",
        payload: ""
      });

      this._dispatchQueue();
    };
  }

  private _socketSend(socketMessage: ISocketMessage) {
    const socket: WebSocket | null = this._socket;

    if (!socket) {
      throw new Error("Missing socket: required for sending message");
    }
    const message: string = JSON.stringify(socketMessage);

    socket.send(message);
  }

  private async _socketReceive(event: MessageEvent) {
    let socketMessage: ISocketMessage;

    try {
      socketMessage = JSON.parse(event.data);
    } catch (error) {
      throw error;
    }

    const activeTopics = [this.clientId, this.handshakeTopic];
    if (!activeTopics.includes(socketMessage.topic)) {
      return;
    }

    let encryptionPayload: IEncryptionPayload;
    try {
      encryptionPayload = JSON.parse(socketMessage.payload);
    } catch (error) {
      throw error;
    }

    const payload:
      | IJsonRpcRequest
      | IJsonRpcResponse
      | null = await this._decrypt(encryptionPayload);

    if (payload) {
      this._triggerEvents(payload);
    }
  }

  private _setToQueue(socketMessage: ISocketMessage) {
    this._queue.push(socketMessage);
  }

  private _dispatchQueue() {
    const queue = this._queue;

    queue.forEach((socketMessage: ISocketMessage) =>
      this._socketSend(socketMessage)
    );

    this._queue = [];
  }

  // -- uri ------------------------------------------------------------- //

  private _formatUri() {
    const protocol = this.protocol;
    const handshakeTopic = this.handshakeTopic;
    const version = this.version;
    const bridge = encodeURIComponent(this.bridge);
    const key = this.key;
    const uri = `${protocol}:${handshakeTopic}@${version}?bridge=${bridge}&key=${key}`;
    return uri;
  }

  private _parseUri(uri: string) {
    const result: IParseURIResult = parseWalletConnectUri(uri);

    if (result.protocol === this.protocol) {
      if (!result.handshakeTopic) {
        throw Error("Invalid or missing handshakeTopic parameter value");
      }
      const handshakeTopic = result.handshakeTopic;

      if (!result.bridge) {
        throw Error("Invalid or missing bridge url parameter value");
      }
      const bridge = decodeURIComponent(result.bridge);

      if (!result.key) {
        throw Error("Invalid or missing kkey parameter value");
      }
      const key = result.key;

      return { handshakeTopic, bridge, key };
    } else {
      throw new Error("URI format doesn't follow Connector protocol");
    }
  }

  // -- crypto ---------------------------------------------------------- //

  private async _generateKey(): Promise<ArrayBuffer | null> {
    if (this.cryptoLib) {
      const result = await this.cryptoLib.generateKey();
      return result;
    }
    return null;
  }

  private async _encrypt(
    data: IJsonRpcRequest | IJsonRpcResponse
  ): Promise<IEncryptionPayload | null> {
    const key: ArrayBuffer | null = this._key;
    if (this.cryptoLib && key) {
      const result: IEncryptionPayload = await this.cryptoLib.encrypt(
        data,
        key
      );
      return result;
    }
    return null;
  }

  private async _decrypt(
    payload: IEncryptionPayload
  ): Promise<IJsonRpcRequest | IJsonRpcResponse | null> {
    const key: ArrayBuffer | null = this._key;
    if (this.cryptoLib && key) {
      const result:
        | IJsonRpcRequest
        | IJsonRpcResponse
        | null = await this.cryptoLib.decrypt(payload, key);
      return result;
    }
    return null;
  }

  // -- storage --------------------------------------------------------- //

  private _getStorageSession(): IWalletConnectSession | null {
    let session = null;
    let local = null;
    if (storage) {
      local = storage.getItem(storageId);
    }
    if (local && typeof local === "string") {
      try {
        const json = JSON.parse(local);
        if (isWalletConnectSession(json)) {
          session = json;
        }
      } catch (error) {
        throw error;
      }
    }
    return session;
  }

  private _setStorageSession(): IWalletConnectSession {
    const session: IWalletConnectSession = this.session;
    const local: string = JSON.stringify(session);
    if (storage) {
      storage.setItem(storageId, local);
    }
    return session;
  }

  private _removeStorageSession(): void {
    if (storage) {
      storage.removeItem(storageId);
    }
  }
}

export default Connector;
