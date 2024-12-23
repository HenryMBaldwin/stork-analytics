import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
  try {
    const response = await fetch('https://rest.dev.jp.stork-oracle.network/v1/prices/assets');
    const result = await response.json();
    return {
      assets: result.data
    };
  } catch (error) {
    console.error('Failed to fetch assets:', error);
    return {
      assets: []
    };
  }
};