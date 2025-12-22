export function subjectFor(moduleName: string, event: string): string {
  // Convention: feedeater.<module>.<event>
  // Example: feedeater.rss.messageCreated
  return `feedeater.${moduleName}.${event}`;
}

export function isFeedeaterSubject(subject: string): boolean {
  return subject.startsWith("feedeater.");
}


