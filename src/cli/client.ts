import type { FractalConfig } from "../config.ts";
import type { ControlRequest, ControlResponse } from "../api/types.ts";

export class ControlClient {
  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly token: string,
  ) {}

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  async ping(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(800),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async rpc(request: ControlRequest): Promise<ControlResponse> {
    const response = await fetch(`${this.baseUrl}/v1/rpc`, {
      method: "POST",
      headers: {
        ...this.headers(),
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
    return (await response.json()) as ControlResponse;
  }

  private headers(): Record<string, string> {
    if (!this.token) return {};
    return { authorization: `Bearer ${this.token}` };
  }
}

export function controlClient(config: FractalConfig): ControlClient {
  return new ControlClient(config.controlHost, config.controlPort, config.controlToken);
}
