// UI preferences in localStorage under `forge.<key>`; storage can be absent or throw (private mode), so every access is guarded.
export const pref = {
  get(k: string, d: string): string {
    try {
      return localStorage.getItem(`forge.${k}`) ?? d;
    } catch {
      return d;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(`forge.${k}`, v);
    } catch {}
  },
};
