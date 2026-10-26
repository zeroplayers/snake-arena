/**
 * Typed client for the arena HTTP API. Shared by route loaders (server and client) and,
 * later, the CLI. Endpoints other than `/api/health` are stubs until their issues land.
 */

export interface Health {
  ok: true;
  environment: string;
}

export interface LeaderboardEntry {
  rank: number;
  botId: string;
  botName: string;
  /** `/@{author}/{botSlug}`. */
  botSlug: string;
  author: string;
  version: number;
  rating: number;
  /** Half-width of the confidence interval around `rating`. */
  ratingCi: number;
  /** `rating - ratingCi`: what the leaderboard is sorted by. */
  lowerBound: number;
  /** Lives behind `rating` (`ratings.n_lives`). */
  ratedLives: number;
  /** Every life the version played. */
  lives: number;
}

export interface BotSummary {
  id: string;
  name: string;
  /** `/@{username}/{slug}`. */
  slug: string;
  activeVersion: number | null;
  /** The active version's rating, `null` while it has none. */
  rating: number | null;
  ratingCi: number | null;
  /** Lives behind `rating` (at most the last 200). */
  ratedLives: number | null;
  lives: number;
}

export interface Profile {
  username: string;
  avatarUrl: string | null;
  joinedAt: string;
  bots: BotSummary[];
}

export interface LeaderboardQuery {
  limit?: number;
  offset?: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClientOptions {
  /** Origin to prefix requests with. Empty means same-origin (browser). */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export function createApiClient({ baseUrl = "", fetch: doFetch = fetch }: ApiClientOptions = {}) {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await doFetch(`${baseUrl}${path}`, {
      ...init,
      headers: { accept: "application/json", ...init?.headers },
    });
    if (!res.ok) {
      throw new ApiError(res.status, path, `${init?.method ?? "GET"} ${path} → ${res.status}`);
    }
    return (await res.json()) as T;
  }

  return {
    health: () => request<Health>("/api/health"),
    leaderboard: ({ limit = 50, offset = 0 }: LeaderboardQuery = {}) =>
      request<LeaderboardEntry[]>(`/api/leaderboard?limit=${limit}&offset=${offset}`),
    profile: (username: string) => request<Profile>(`/api/users/${encodeURIComponent(username)}`),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

export const api = createApiClient();
