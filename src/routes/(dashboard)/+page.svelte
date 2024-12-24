<script lang="ts">
	import { enhance } from '$app/forms';
	import { ethers } from 'ethers';
	import { writable, type Writable } from 'svelte/store';
	import { onDestroy } from 'svelte';
	
	let chainId: string = '';
	let contractAddress: string = '';
	let loading = false;
	let progress = '';
	let error: string | null = null;
	let wsProvider: ethers.WebSocketProvider | null = null;
	let currentChainName: string = '';
	let abortController: AbortController | null = null;
	let contractInterface: ethers.Interface | null = null;
	let wsConnected = false;
	let wsError: string | null = null;

	// Create a writable store for transactions
	const transactionStore: Writable<any[]> = writable([]);

	// Fetch ABI from Arbitrum Sepolia implementation contract
	async function fetchABI() {
		try {
			// First get the implementation address from the known proxy on Arbitrum Sepolia
			const ARBITRUM_PROXY = '0x7Bb9740FdcbD91866CaFEd099C36445Ea8140627';
			const provider = new ethers.JsonRpcProvider('https://sepolia-rollup.arbitrum.io/rpc');
			
			// ERC1967 implementation slot
			const implementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
			const implementationBytes = await provider.getStorage(ARBITRUM_PROXY, implementationSlot);
			const implementationAddress = '0x' + implementationBytes.slice(-40); // last 20 bytes
			
			console.log('Found implementation address:', implementationAddress);
			
			// Get the ABI from the implementation contract
			const response = await fetch(`https://api-sepolia.arbiscan.io/api?module=contract&action=getabi&address=${implementationAddress}`);
			const data = await response.json();
			
			if (data.status === '1' && data.result) {
				console.log('Got ABI from implementation contract');
				const abiJson = JSON.parse(data.result);
				
				// Also log function signatures
				const funcSigs = abiJson
					.filter((item: any) => item.type === 'function')
					.map((func: any) => `${func.name}(${func.inputs.map((i: any) => i.type).join(',')})`);
				console.log('Available functions:', funcSigs);
				
				contractInterface = new ethers.Interface(abiJson);
				
				// Try to get the selector we're looking for
				try {
					const updateFunc = contractInterface.getFunction('updateTemporalNumericValuesV1');
					console.log('Update function selector:', updateFunc?.selector);
				} catch (e) {
					console.warn('Could not find updateTemporalNumericValuesV1 function');
				}
				
				return true;
			} else {
				console.warn('Failed to get implementation ABI:', data);
				return false;
			}
		} catch (e) {
			console.error('Error fetching ABI:', e);
			return false;
		}
	}

	// Decode transaction input data
	function decodeInput(data: string): any {
		if (!contractInterface || !data) return null;
		
		try {
			console.log('\nDecoding transaction:', data);
			console.log('Function selector:', data.slice(0, 10));
			
			// Log available functions
			try {
				const fragment = contractInterface.getFunction('updateTemporalNumericValuesV1');
				if (fragment) {
					console.log('Update function details:', {
						name: fragment.name,
						selector: fragment.selector,
						format: fragment.format()
					});
				} else {
					console.log('Update function not found in interface');
				}
			} catch (e) {
				console.log('Could not find update function');
			}
			
			try {
				const decoded = contractInterface.parseTransaction({ data });
				console.log('Successfully decoded:', decoded);
				
				if (!decoded) return null;
				
				return {
					name: decoded.name,
					args: decoded.args
				};
			} catch (e) {
				console.log('Failed to decode:', e);
				return null;
			}
		} catch (e) {
			console.warn('Error in decode process:', e);
			return null;
		}
	}
	
	// Handle BigInt serialization
	function jsonReplacer(key: string, value: any) {
		if (typeof value === 'bigint') {
			return value.toString();
		}
		return value;
	}

	// Add a transaction to the store
	function addTransaction(tx: any) {
		if (!tx) return;
		
		// Only keep creation and incoming transactions
		if (!tx.to || tx.to.toLowerCase() === contractAddress.toLowerCase()) {
			const decodedInput = tx.data ? decodeInput(tx.data) : null;
			
			transactionStore.update(txs => {
				// Check if we already have this transaction
				if (!txs.find(t => t.hash === tx.hash)) {
					const enrichedTx = {
						...tx,
						decodedInput
					};
					return [enrichedTx, ...txs].sort((a, b) => (b.blockNumber || 0) - (a.blockNumber || 0));
				}
				return txs;
			});
		}
	}

	// Subscribe to new events
	function subscribeToEvents(provider: ethers.WebSocketProvider) {
		try {
			const filter = {
				address: contractAddress,
				topics: []
			};
			
			provider.on(filter, async (log) => {
				if (!log.transactionHash) return;
				
				try {
					const tx = await provider.getTransaction(log.transactionHash);
					addTransaction(tx);
				} catch (e) {
					console.warn('Error fetching new transaction:', e);
				}
			});
			
			// Add connection status handlers
			provider.on('connect', () => {
				console.log('WebSocket connected');
				wsConnected = true;
				wsError = null;
			});
			
			provider.on('disconnect', () => {
				console.log('WebSocket disconnected');
				wsConnected = false;
				wsError = 'Disconnected from websocket';
			});
			
			provider.on('error', (error) => {
				console.log('WebSocket error:', error);
				wsConnected = false;
				wsError = error?.message || 'Unknown websocket error';
			});
			
			console.log('Subscribed to new events');
		} catch (e: any) {
			console.error('Error setting up event subscription:', e);
			wsConnected = false;
			wsError = e?.message || 'Failed to setup websocket';
		}
	}

	async function fetchTransactions() {
		loading = true;
		error = null;
		transactionStore.set([]);
		currentChainName = '';
		abortController = new AbortController();
		
		try {
			progress = 'Fetching chain info...';
			const chainlistResponse = await fetch(`https://chainid.network/chains.json`);
			const chains = await chainlistResponse.json();
			const chain = chains.find((c: any) => c.chainId === parseInt(chainId));
			
			if (!chain) {
				throw new Error(`Chain ID ${chainId} not found`);
			}

			currentChainName = chain.name;
			console.log('Using chain:', chain.name);
			
			// Fetch ABI first
			progress = 'Fetching contract ABI...';
			await fetchABI();
			
			// Setup providers
			const rpcUrl = chain.rpc[0];
			const provider = new ethers.JsonRpcProvider(rpcUrl);
			
			// Try to set up websocket if available
			const wsUrl = chain.rpc.find((url: string) => url.startsWith('wss://'));
			if (wsUrl) {
				try {
					wsProvider?.destroy();
					wsProvider = new ethers.WebSocketProvider(wsUrl);
					subscribeToEvents(wsProvider);
				} catch (e) {
					console.warn('Failed to setup websocket:', e);
				}
			}
			
			progress = 'Getting latest block...';
			const latestBlock = await provider.getBlockNumber();
			console.log('Latest block:', latestBlock);
			
			let chunkSize = 100_000;
			let consecutiveSuccesses = 0;
			let consecutiveFailures = 0;
			let foundCreation = false;
			let retryDelay = 1000; // Start with 1 second delay
			
			// Search backwards in chunks until we find the contract creation
			for (let block = latestBlock; block > 0 && !abortController?.signal.aborted;) {
				const fromBlock = Math.max(0, block - chunkSize);
				progress = `Fetching logs for blocks ${fromBlock.toLocaleString()} to ${block.toLocaleString()} of ${latestBlock.toLocaleString()}...`;
				
				try {
					const logs = await provider.getLogs({
						address: contractAddress,
						fromBlock,
						toBlock: block
					});
					
					console.log(`Found ${logs.length} logs in range ${fromBlock}-${block}`);
					
					const txHashes = [...new Set(logs.map(log => log.transactionHash).filter(Boolean))];
					const BATCH_SIZE = 20;
					const batches = [];
					for (let i = 0; i < txHashes.length; i += BATCH_SIZE) {
						const batch = txHashes.slice(i, i + BATCH_SIZE);
						batches.push(batch);
					}

					for (const batch of batches) {
						let batchSuccess = false;
						let batchRetries = 0;
						
						while (!batchSuccess && batchRetries < 3 && !abortController?.signal.aborted) {
							try {
								progress = `Processing ${batch.length} transactions...`;
								const [txs, receipts] = await Promise.all([
									Promise.all(batch.map(hash => provider.getTransaction(hash))),
									Promise.all(batch.map(hash => provider.getTransactionReceipt(hash)))
								]);
								
								// Add transactions to store as they come in
								txs.forEach(addTransaction);
								
								// Check for contract creation
								for (const receipt of receipts) {
									if (receipt?.contractAddress?.toLowerCase() === contractAddress.toLowerCase()) {
										console.log('Found contract creation at block:', receipt.blockNumber);
										foundCreation = true;
										break;
									}
								}
								
								batchSuccess = true;
							} catch (e) {
								console.warn(`Batch retry ${batchRetries + 1}/3 failed:`, e);
								batchRetries++;
								if (batchRetries < 3) {
									await new Promise(resolve => setTimeout(resolve, retryDelay));
									retryDelay = Math.min(retryDelay * 1.5, 10000); // Exponential backoff up to 10s
								}
							}
						}
						
						if (foundCreation) break;
					}
					
					if (foundCreation) break;
					
					// Success for this chunk
					consecutiveSuccesses++;
					consecutiveFailures = 0;
					retryDelay = Math.max(1000, retryDelay / 1.5); // Reduce delay on success
					
					if (consecutiveSuccesses >= 2) {
						const newChunkSize = Math.min(500_000, Math.floor(chunkSize * 1.5));
						if (newChunkSize !== chunkSize) {
							console.log(`Increasing chunk size to ${newChunkSize}`);
							chunkSize = newChunkSize;
							consecutiveSuccesses = 0;
						}
					}
					
					// Move to next chunk
					block -= chunkSize;
					
				} catch (e: any) {
					console.warn(`Error in chunk ${fromBlock}-${block}:`, e?.message || e);
					consecutiveFailures++;
					consecutiveSuccesses = 0;
					
					// Check for rate limit errors
					if (e?.message?.includes('rate') || e?.message?.includes('limit')) {
						console.log('Rate limit hit, increasing delay...');
						retryDelay = Math.min(retryDelay * 2, 10000); // Double delay up to 10s
						await new Promise(resolve => setTimeout(resolve, retryDelay));
					} else {
						// Other errors - reduce chunk size
						const reduction = consecutiveFailures > 2 ? 4 : 2;
						chunkSize = Math.max(1000, Math.floor(chunkSize / reduction));
						console.log(`Reducing chunk size to ${chunkSize} after ${consecutiveFailures} failures`);
					}
					
					// Don't move the block pointer - retry the same chunk
					continue;
				}
			}
			
			// Update final progress
			const txCount = $transactionStore.length;
			progress = `Found ${txCount} transaction${txCount === 1 ? '' : 's'}`;
			console.log('Fetch complete:', progress);
			
		} catch (e: any) {
			console.error('Error in fetchTransactions:', e);
			error = e.message;
		} finally {
			loading = false;
			abortController = null;
		}
	}

	function cancelFetch() {
		if (abortController) {
			abortController.abort();
		}
		wsProvider?.destroy();
		wsProvider = null;
		wsConnected = false;
		wsError = 'Cancelled';
	}

	// Cleanup on component destroy
	onDestroy(() => {
		wsProvider?.destroy();
		wsConnected = false;
		wsError = null;
	});
</script>

<div class="container mx-auto p-4 space-y-8">
	<h1 class="h1">Contract Transaction Dashboard</h1>
	
	<div class="card p-4">
		<form class="space-y-4" on:submit|preventDefault={fetchTransactions}>
			<div class="space-y-2">
				<label class="label" for="chainId">
					<span>Chain ID</span>
				</label>
				<input
					class="input"
					type="text"
					id="chainId"
					bind:value={chainId}
					placeholder="e.g. 1 for Ethereum Mainnet"
					required
				/>
			</div>
			
			<div class="space-y-2">
				<label class="label" for="contractAddress">
					<span>Contract Address</span>
				</label>
				<input
					class="input"
					type="text"
					id="contractAddress"
					bind:value={contractAddress}
					placeholder="0x..."
					required
				/>
			</div>
			
			<div class="flex gap-4">
				<button type="submit" class="btn variant-filled-primary" disabled={loading}>
					{loading ? 'Loading...' : 'Fetch Transactions'}
				</button>
				{#if loading}
					<button type="button" class="btn variant-filled-error" on:click={cancelFetch}>
						Cancel
					</button>
				{/if}
			</div>
		</form>
	</div>
	
	{#if loading}
		<div class="card p-4">
			<div class="flex items-center space-x-4">
				<div class="spinner-border" role="status"></div>
				<span>{progress}</span>
			</div>
		</div>
	{/if}
	
	<div class="card p-4 {wsConnected ? 'bg-success-500/20' : 'bg-error-500/20'}">
		<div class="flex items-center space-x-2">
			<div class="w-2 h-2 rounded-full {wsConnected ? 'bg-success-500' : 'bg-error-500'} animate-pulse"></div>
			<span>
				{#if wsConnected}
					WebSocket Connected - Listening for new transactions
				{:else if wsError}
					<span class="tooltip tooltip-bottom" data-tip={wsError}>
						WebSocket Disconnected - Hover for details
					</span>
				{:else}
					No WebSocket Available
				{/if}
			</span>
		</div>
	</div>
	
	{#if error}
		<div class="alert variant-filled-error">
			{error}
		</div>
	{/if}
	
	{#if !loading && $transactionStore.length === 0 && !error}
		<div class="card p-4">
			<div class="text-center text-gray-500">
				No transactions found for {currentChainName || 'this contract'}.
			</div>
		</div>
	{/if}
	
	{#if $transactionStore.length > 0}
		<div class="card p-4">
			<h2 class="h2">Transactions ({$transactionStore.length})</h2>
			<div class="table-container">
				<table class="table table-compact">
					<thead>
						<tr>
							<th>Block</th>
							<th>Hash</th>
							<th>From</th>
							<th>Type</th>
							<th>Function</th>
							<th>Arguments</th>
						</tr>
					</thead>
					<tbody>
						{#each $transactionStore as tx}
							<tr>
								<td>{tx.blockNumber}</td>
								<td class="font-mono text-xs break-all whitespace-normal">{tx.hash}</td>
								<td class="font-mono break-all">{tx.from}</td>
								<td>{!tx.to ? 'Creation' : 'Incoming'}</td>
								<td class="font-mono">{tx.decodedInput?.name || 'Unknown'}</td>
								<td class="font-mono break-all">
									<div class="max-h-32 overflow-y-auto">
										{#if tx.decodedInput?.args}
											<pre class="text-xs">{JSON.stringify(tx.decodedInput.args, jsonReplacer, 2)}</pre>
										{:else}
											{tx.data}
										{/if}
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}
</div>

<style>
	.table-container {
		@apply overflow-x-auto;
	}
	
	.spinner-border {
		@apply w-8 h-8 border-4 border-primary-500 border-r-transparent rounded-full animate-spin;
	}
</style>
