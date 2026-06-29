export class SuppressionList {
  private blacklist = new Set<string>();

  public blockEmail(email: string): void {
    this.blacklist.add(email.toLowerCase());
  }

  public isAllowed(email: string): boolean {
    return !this.blacklist.has(email.toLowerCase());
  }
}
