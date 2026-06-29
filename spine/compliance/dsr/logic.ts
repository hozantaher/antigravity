export class DsrManager {
  private deletionQueue = new Set<string>();

  public requestDeletion(userId: string): void {
    this.deletionQueue.add(userId);
  }

  public isMarkedForDeletion(userId: string): boolean {
    return this.deletionQueue.has(userId);
  }
}
