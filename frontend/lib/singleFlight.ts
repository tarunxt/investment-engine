export class SingleFlightByKey<T> {
  private readonly flights = new Map<string, Promise<T>>();

  run(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.flights.get(key);
    if (existing) return existing;
    const flight = operation().finally(() => {
      if (this.flights.get(key) === flight) {
        this.flights.delete(key);
      }
    });
    this.flights.set(key, flight);
    return flight;
  }
}
