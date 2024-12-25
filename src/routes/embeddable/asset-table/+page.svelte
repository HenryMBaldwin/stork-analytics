<!-- Create a standalone embeddable asset table -->
<script lang="ts">
	import { onMount } from 'svelte';
	import { writable } from 'svelte/store';
	import { ethers } from 'ethers';
	import { browser } from '$app/environment';

	// Search query
	let searchQuery = '';

	// Store for asset data
	const assetStore = writable<[string, string][]>([]);

	// Filtered assets
	$: filteredAssets = $assetStore.filter(([plaintext]) => 
		!searchQuery || plaintext.toLowerCase().includes(searchQuery.toLowerCase())
	);

	// Send height to parent window
	function sendHeight() {
		if (!browser) return;
		const tableContainer = document.querySelector('.table-container');
		if (!tableContainer) {
			console.log('Table container not found');
			return;
		}
		
		const height = tableContainer.scrollHeight;
		console.log('Sending height:', height + 32);
		window.parent.postMessage({ type: 'resize', height: height + 32 }, '*');
	}

	// Update height when filtered results change
	$: if (browser) {
		filteredAssets;
		setTimeout(sendHeight, 0);
	}

	// Fetch assets and set up resize observer
	onMount(() => {
		fetch('/api/assets')
			.then(response => response.json())
			.then(({ data: assetIds }) => {
				const assetPairs = assetIds.map((id: string) => [
					id,
					ethers.keccak256(ethers.toUtf8Bytes(id))
				]);
				assetStore.set(assetPairs);
				setTimeout(sendHeight, 100); // Longer delay for initial load
			})
			.catch(e => console.error('Error fetching asset IDs:', e));

		const resizeObserver = new ResizeObserver(sendHeight);
		const tableContainer = document.querySelector('.table-container');
		if (tableContainer) {
			resizeObserver.observe(tableContainer);
		}

		return () => resizeObserver.disconnect();
	});
</script>

<div class="table-container p-4">
	<!-- Search Bar -->
	<div class="card p-4 mb-4">
		<input
			type="text"
			class="input w-full"
			placeholder="Search assets..."
			bind:value={searchQuery}
		/>
	</div>

	<!-- Results Table -->
	<table class="table table-compact w-full">
		<thead>
			<tr>
				<th>Asset ID</th>
				<th>Encoded ID</th>
			</tr>
		</thead>
		<tbody>
			{#if filteredAssets.length === 0}
				<tr>
					<td colspan="2" class="text-center text-gray-500 py-4">
						No assets{searchQuery ? ' matching search' : ''}.
					</td>
				</tr>
			{:else}
				{#each filteredAssets as [plaintext, encoded]}
					<tr>
						<td data-label="Asset ID">{plaintext}</td>
						<td data-label="Encoded ID" class="font-mono text-sm break-all">{encoded}</td>
					</tr>
				{/each}
			{/if}
		</tbody>
	</table>
</div>

<style>
	:global(body) {
		margin: 0;
		padding: 0;
	}

	/* Table styles */
	.table {
		@apply w-full border-collapse;
	}

	.table th,
	.table td {
		@apply border border-secondary-500 p-2;
		@apply text-left;
	}

	.card {
		@apply border border-secondary-500;
	}

	:global(.dark) .table {
		@apply border-primary-900 bg-surface-700;
	}

	:global(.dark) .table th {
		@apply border-primary-900 bg-surface-800;
	}

	:global(.dark) .table td {
		@apply border-primary-900 bg-surface-700;
	}

	:global(.dark) .table tr:nth-child(even) td {
		@apply bg-surface-800;
	}

	:global(.dark) .card {
		@apply border-primary-900;
	}

	/* Responsive table styles */
	@media (max-width: 640px) {
		.table {
			@apply w-full;
		}

		.table th,
		.table td {
			@apply block w-full;
		}

		.table tr {
			@apply block border-b border-secondary-500 mb-4;
		}

		:global(.dark) .table tr {
			@apply border-primary-900;
		}

		.table td {
			@apply pl-[8rem] relative;
		}

		.table td::before {
			content: attr(data-label);
			@apply absolute left-4 font-semibold;
		}

		.table thead {
			@apply hidden;
		}
	}
</style> 