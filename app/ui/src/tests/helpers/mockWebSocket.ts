export class MockWebSocket {
  public static OPEN = 1
  public static CLOSED = 3
  public readyState: number = MockWebSocket.OPEN
  public url: string
  public onopen: (() => void) | null = null
  public onmessage: ((event: { data: string }) => void) | null = null
  public onclose: (() => void) | null = null
  public onerror: ((error: any) => void) | null = null
  public sentMessages: string[] = []

  constructor(url: string) {
    this.url = url
    setTimeout(() => {
      if (this.onopen) this.onopen()
    }, 0)
  }

  send(data: string) {
    this.sentMessages.push(data)
  }

  close() {
    this.readyState = MockWebSocket.CLOSED
    if (this.onclose) this.onclose()
  }

  triggerMessage(data: any) {
    if (this.onmessage) {
      this.onmessage({ data: typeof data === 'string' ? data : JSON.stringify(data) })
    }
  }

  triggerError(error: any) {
    if (this.onerror) this.onerror(error)
  }
}
