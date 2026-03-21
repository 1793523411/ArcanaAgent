declare module "pagerank.js" {
  interface PagerankModule {
    link(source: string, target: string, weight?: number): void;
    rank(alpha: number, epsilon: number, callback: (node: string, rank: number) => void): void;
    reset(): void;
  }
  const pagerank: PagerankModule;
  export default pagerank;
}
