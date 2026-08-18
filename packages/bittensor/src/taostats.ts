/**
 * Typed client for the taostats.io API.
 *
 * The API key format is `tao-<uuid>:<secret>` as seen in the curl example:
 *   Authorization: tao-7d70ba09-abd4-4d16-9270-7ea89c7c9ce7:b7ed7d72
 */

export interface TaostatsPagination {
  current_page: number;
  per_page: number;
  total_items: number;
  total_pages: number;
  next_page: number | null;
  prev_page: number | null;
}

export interface DevActivityEntry {
  netuid: number;
  repo_url: string;
  as_of_day: string;
  commits_1d: number;
  prs_opened_1d: number;
  prs_merged_1d: number;
  issues_opened_1d: number;
  issues_closed_1d: number;
  reviews_1d: number;
  comments_1d: number;
  unique_contributors_1d: number;
  commits_7d: number;
  prs_opened_7d: number;
  prs_merged_7d: number;
  issues_opened_7d: number;
  issues_closed_7d: number;
  reviews_7d: number;
  comments_7d: number;
  unique_contributors_7d: number;
  commits_30d: number;
  prs_opened_30d: number;
  prs_merged_30d: number;
  issues_opened_30d: number;
  issues_closed_30d: number;
  reviews_30d: number;
  comments_30d: number;
  unique_contributors_30d: number;
  last_event_at: string;
  days_since_last_event: number;
}

export interface DevActivityResponse {
  pagination: TaostatsPagination;
  data: DevActivityEntry[];
}

export class TaostatsClient {
  private authHeader: string;
  private baseUrl = "https://api.taostats.io/api";

  /**
   * Accepts either the full "tao-xxx:yyy" string or separate key/secret parts.
   */
  constructor(apiKey: string, apiSecret?: string) {
    if (!apiKey) throw new Error("TAOSTATS_API_KEY is required");
    this.authHeader = apiSecret ? `${apiKey}:${apiSecret}` : apiKey;
  }

  async getDevActivity(page = 1, perPage = 50): Promise<DevActivityResponse> {
    const url = new URL(`${this.baseUrl}/dev_activity/latest/v1`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(perPage));

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "unknown");
      throw new Error(`taostats API error ${res.status}: ${text}`);
    }

    return res.json() as Promise<DevActivityResponse>;
  }

  async getSubnetActivity(netuid: number): Promise<DevActivityEntry | null> {
    for (let page = 1; page <= 5; page++) {
      const resp = await this.getDevActivity(page, 50);
      const found = resp.data.find((d) => d.netuid === netuid);
      if (found) return found;
      if (!resp.pagination.next_page) break;
    }
    return null;
  }

  async listSubnets(): Promise<Array<{ netuid: number; repo_url: string; as_of_day: string; last_event_at: string }>> {
    const results: Array<{ netuid: number; repo_url: string; as_of_day: string; last_event_at: string }> = [];
    let page = 1;

    while (true) {
      const resp = await this.getDevActivity(page, 50);
      for (const entry of resp.data) {
        results.push({
          netuid: entry.netuid,
          repo_url: entry.repo_url,
          as_of_day: entry.as_of_day,
          last_event_at: entry.last_event_at,
        });
      }
      if (!resp.pagination.next_page || page >= 20) break;
      page++;
    }

    return results;
  }
}
