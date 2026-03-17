/**
 * FRED (Federal Reserve Economic Data) API client.
 * Docs: https://fred.stlouisfed.org/docs/api/fred/
 */

type Logger = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

const TENOR_TO_SERIES: Record<string, string> = {
	"3m": "DGS3MO",
	"6m": "DGS6MO",
	"1y": "DGS1",
	"2y": "DGS2",
	"5y": "DGS5",
	"10y": "DGS10",
	"30y": "DGS30",
};

export class FredClient {
	private baseUrl = "https://api.stlouisfed.org/fred";

	constructor(
		private apiKey: string,
		private logger: Logger,
	) {}

	private async fetch(path: string, params: Record<string, string> = {}): Promise<unknown> {
		const url = new URL(`${this.baseUrl}${path}`);
		url.searchParams.set("api_key", this.apiKey);
		url.searchParams.set("file_type", "json");
		for (const [k, v] of Object.entries(params)) {
			url.searchParams.set(k, v);
		}

		const response = await globalThis.fetch(url.toString());
		if (!response.ok) {
			const text = await response.text();
			throw new Error(`FRED API error ${response.status}: ${text}`);
		}
		return response.json();
	}

	async getRiskFreeRate(tenor: string) {
		const seriesId = TENOR_TO_SERIES[tenor];
		if (!seriesId) {
			return { error: `Unknown tenor: ${tenor}. Valid: ${Object.keys(TENOR_TO_SERIES).join(", ")}` };
		}

		const data = await this.fetch("/series/observations", {
			series_id: seriesId,
			sort_order: "desc",
			limit: "5",
		});

		return { tenor, series_id: seriesId, data };
	}

	async getEconomicCalendar(daysAhead: number) {
		// FRED doesn't have a native "calendar" endpoint.
		// We fetch recent release dates for key series.
		const keySeries = [
			{ id: "UNRATE", name: "Unemployment Rate (NFP)" },
			{ id: "CPIAUCSL", name: "CPI (Consumer Price Index)" },
			{ id: "FEDFUNDS", name: "Federal Funds Rate" },
			{ id: "GDP", name: "GDP" },
			{ id: "RSAFS", name: "Retail Sales" },
		];

		const results = await Promise.all(
			keySeries.map(async (series) => {
				try {
					const data = await this.fetch("/series/observations", {
						series_id: series.id,
						sort_order: "desc",
						limit: "2",
					});
					return { ...series, latest: data };
				} catch {
					return { ...series, latest: null };
				}
			}),
		);

		return {
			days_ahead: daysAhead,
			note: "FRED provides latest release data, not a forward calendar. Consider supplementing with a dedicated economic calendar API.",
			series: results,
		};
	}
}
