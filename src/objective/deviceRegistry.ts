import WebSocket from "ws";

export interface AuthenticatedDeviceConnection {
  deviceId: string;
  bootId: string;
  firmware: string;
  webSocket: WebSocket;
}

export class ObjectiveDeviceRegistry {
  private readonly connections = new Map<string, AuthenticatedDeviceConnection>();

  get size(): number {
    return this.connections.size;
  }

  register(connection: AuthenticatedDeviceConnection): AuthenticatedDeviceConnection | undefined {
    const previous = this.connections.get(connection.deviceId);
    this.connections.set(connection.deviceId, connection);
    return previous;
  }

  unregister(deviceId: string, webSocket: WebSocket): boolean {
    const current = this.connections.get(deviceId);
    if (current?.webSocket !== webSocket) {
      return false;
    }

    this.connections.delete(deviceId);
    return true;
  }

  isCurrent(deviceId: string, webSocket: WebSocket): boolean {
    return this.connections.get(deviceId)?.webSocket === webSocket;
  }

  isConnected(deviceId: string): boolean {
    return this.connections.get(deviceId)?.webSocket.readyState === WebSocket.OPEN;
  }

  send(deviceId: string, message: string): boolean {
    const connection = this.connections.get(deviceId);
    if (connection?.webSocket.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      connection.webSocket.send(message);
      return true;
    } catch {
      return false;
    }
  }
}
