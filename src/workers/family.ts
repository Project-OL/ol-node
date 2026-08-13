export type WorkerFamily = {
  name: string
  close: () => Promise<void>
}
