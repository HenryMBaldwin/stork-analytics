import { json } from '@sveltejs/kit';

export async function GET() {
	try {
		const response = await fetch('https://rest.dev.jp.stork-oracle.network/v1/prices/assets');
		const data = await response.json();
		return json(data);
	} catch (error) {
		console.error('Error fetching assets:', error);
		return json({ error: 'Failed to fetch assets' }, { status: 500 });
	}
} 