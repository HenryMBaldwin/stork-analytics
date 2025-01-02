<script lang="ts">
	import { enhance } from '$app/forms';
	import { ethers } from 'ethers';
	import { writable, get, type Writable } from 'svelte/store';
	import { onDestroy } from 'svelte';
	import { popup, Tab, TabGroup } from '@skeletonlabs/skeleton';
	
	let chainId: string = '';
	let contractAddress: string = '';
	let loading = false;
	let canceling = false;
	let progress = '';
	let error: string | null = null;
	let currentChainName: string = '';
	let abortController: AbortController | null = null;
	let contractInterface: ethers.Interface | null = null;
	let assetIdMap: Map<string, string> = new Map();
	let lastCheckedBlock: number | null = null;
	let currentView: 'transactions' | 'values' = 'transactions';
	let valueSearchQuery = '';
	let showOnlyFound = true;  // Default to showing only found assets
	let scanTxs = true;  // Default to scanning transactions
	let scanAssets = true;  // Default to scanning assets
	const assetValues: Writable<Map<string, { value: number; timestamp: number; found: boolean; failed?: boolean }>> = writable(new Map());
	let scanningValues = false;
	const scanProgress = writable('');
	const sortState = writable({
		column: 'status' as 'asset' | 'status' | 'value' | 'timestamp' | null,
		direction: 'desc' as 'asc' | 'desc'  // desc will show Found first
	});

	// Create a writable store for transactions
	const transactionStore: Writable<any[]> = writable([]);

	// Types for our analytics
	interface AssetUpdate {
		timestamp: number;
		value: number;
		from: string;
		txHash: string;
		gasUsed: number;  // Gas attributed to this specific update
	}

	interface UpdaterGasStats {
		totalGas: number;
		updateCount: number;
		averageGas: number;
	}

	interface AssetStats {
		assetName: string;
		lastUpdate: AssetUpdate | null;
		updateCount: number;
		uniqueUpdaters: Set<string>;
		updates: AssetUpdate[];
		totalGas: number;
		updaterGasStats: Map<string, UpdaterGasStats>;
	}

	interface AssetDetails {
		shown: boolean;
		showHashes: boolean;
	}

	// Create stores for our analytics
	const assetStatsStore: Writable<Map<string, AssetStats>> = writable(new Map());
	const aggregateStatsStore: Writable<{
		totalAssets: number;
		totalUpdates: number;
		totalUniqueUpdaters: Set<string>;
		totalGas: number;
		updaterGasStats: Map<string, UpdaterGasStats>;
	}> = writable({
		totalAssets: 0,
		totalUpdates: 0,
		totalUniqueUpdaters: new Set(),
		totalGas: 0,
		updaterGasStats: new Map()
	});

	// Store for tracking expanded details
	const showDetails = writable({
		network: false,
		assets: new Map<string, AssetDetails>()
	});

	// Reset all stores
	function resetStores() {
		transactionStore.set([]);
		assetStatsStore.set(new Map());
		aggregateStatsStore.set({
			totalAssets: 0,
			totalUpdates: 0,
			totalUniqueUpdaters: new Set(),
			totalGas: 0,
			updaterGasStats: new Map()
		});
		showDetails.set({
			network: false,
			assets: new Map<string, AssetDetails>()
		});
	}

	// Selected timeframe for frequency calculation
	let selectedTimeframe: 'day' | 'week' | 'month' | 'year' | 'all' = 'day';

	// Fetch ABI from GitHub repository
	async function fetchABI() {
		try {
			const response = await fetch('https://raw.githubusercontent.com/Stork-Oracle/stork-external/main/contracts/evm/stork.abi');
			const abiJson = await response.json();
			
			console.log('Got ABI from GitHub');
			
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
		} catch (e) {
			console.error('Error fetching ABI:', e);
			return false;
		}
	}

	// Format timestamp from nanoseconds to human readable
	function formatTimestamp(timestampNs: bigint): string {
		const timestampMs = Number(timestampNs) / 1_000_000; // Convert ns to ms
		const date = new Date(timestampMs);
		return date.toLocaleString();
	}

	// Format quantized value (divided by 10^18)
	function formatValue(quantizedValue: bigint): string {
		const value = Number(quantizedValue) / 1e18;
		return value.toString();
	}

	// Fetch asset IDs and create lookup map
	async function fetchAssetIds() {
		try {
			const response = await fetch('/api/assets');
			const { data: assetIds } = await response.json();
			
			console.log('Fetched asset IDs:', assetIds);
			
			// Create lookup map of hash => plaintext
			assetIdMap = new Map(
				assetIds.map((id: string) => [
					ethers.keccak256(ethers.toUtf8Bytes(id)),
					id
				])
			);
			
			console.log('Created asset ID map with', assetIdMap.size, 'entries');
		} catch (e) {
			console.error('Error fetching asset IDs:', e);
		}
	}

	// Get plaintext asset ID from hash
	function getAssetName(hash: string): string {
		return assetIdMap.get(hash.toLowerCase()) || hash;
	}

	// Process update data into a more readable format
	function processUpdateData(args: any[]): any {
		if (!args || !args[0]) return null;
		
		const updates = args[0].map((update: any) => ({
			id: update.id,
			assetName: getAssetName(update.id),
			timestamp: formatTimestamp(update.temporalNumericValue.timestampNs),
			value: formatValue(update.temporalNumericValue.quantizedValue),
			rawTimestamp: update.temporalNumericValue.timestampNs.toString(),
			rawValue: update.temporalNumericValue.quantizedValue.toString()
		}));
		
		return updates;
	}

	// Decode transaction input data
	function decodeInput(data: string): any {
		if (!contractInterface || !data) return null;
		
		try {
			const decoded = contractInterface.parseTransaction({ data });
			
			if (!decoded) return null;
			
			// Only process updateTemporalNumericValuesV1 calls
			if (decoded.name === 'updateTemporalNumericValuesV1') {
				return {
					name: decoded.name,
					updates: processUpdateData(decoded.args)
				};
			}
			
			return null;
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

	// Process transaction into stats
	function processTransactionForStats(tx: any) {
		if (!tx.decodedInput?.updates) return;
		
		const updatesCount = tx.decodedInput.updates.length;
		const gasUsed = tx.receipt?.gasUsed ? Number(tx.receipt.gasUsed) : 0; // Get gas from receipt
		const gasPerUpdate = gasUsed / updatesCount; // Split gas equally among updates
		
		assetStatsStore.update(statsMap => {
			tx.decodedInput.updates.forEach((update: any) => {
				const assetId = update.assetName;
				const currentStats = statsMap.get(assetId) || {
					assetName: assetId,
					updateCount: 0,
					uniqueUpdaters: new Set<string>(),
					updates: [] as AssetUpdate[],
					lastUpdate: null,
					totalGas: 0,
					updaterGasStats: new Map()
				};
				
				const newUpdate: AssetUpdate = {
					timestamp: Number(update.rawTimestamp) / 1_000_000, // Convert to ms
					value: Number(update.rawValue) / 1e18,
					from: tx.from,
					txHash: tx.hash,
					gasUsed: gasPerUpdate
				};
				
				// Update gas stats for this updater
				const updaterStats = currentStats.updaterGasStats.get(tx.from) || {
					totalGas: 0,
					updateCount: 0,
					averageGas: 0
				};
				updaterStats.totalGas += gasPerUpdate;
				updaterStats.updateCount++;
				updaterStats.averageGas = updaterStats.totalGas / updaterStats.updateCount;
				currentStats.updaterGasStats.set(tx.from, updaterStats);
				
				currentStats.totalGas += gasPerUpdate;
				currentStats.updateCount++;
				currentStats.uniqueUpdaters.add(tx.from);
				currentStats.updates.push(newUpdate);
				
				// Update last update if newer
				if (!currentStats.lastUpdate || newUpdate.timestamp > currentStats.lastUpdate.timestamp) {
					currentStats.lastUpdate = newUpdate;
				}
				
				statsMap.set(assetId, currentStats);
			});
			
			return statsMap;
		});
		
		// Update aggregate stats
		aggregateStatsStore.update(stats => {
			tx.decodedInput.updates.forEach((update: any) => {
				stats.totalUpdates++;
				stats.totalUniqueUpdaters.add(tx.from);
				stats.totalGas += gasUsed / updatesCount;
				
				// Update gas stats for this updater
				const updaterStats = stats.updaterGasStats.get(tx.from) || {
					totalGas: 0,
					updateCount: 0,
					averageGas: 0
				};
				updaterStats.totalGas += gasUsed / updatesCount;
				updaterStats.updateCount++;
				updaterStats.averageGas = updaterStats.totalGas / updaterStats.updateCount;
				
				stats.updaterGasStats.set(tx.from, updaterStats);
			});
			return stats;
		});

		// Update progress with current stats
		const stats = get(aggregateStatsStore);
		progress = `Processing transactions... Found ${stats.totalUpdates} updates across ${$assetStatsStore.size} assets`;
	}

	// Calculate update frequency for a timeframe
	function calculateFrequency(updates: AssetUpdate[], timeframe: 'day' | 'week' | 'month' | 'year' | 'all'): number {
		if (updates.length < 2) return 0;
		
		const now = Date.now();
		let cutoff = now;
		
		switch (timeframe) {
			case 'day':
				cutoff = now - 24 * 60 * 60 * 1000;
				break;
			case 'week':
				cutoff = now - 7 * 24 * 60 * 60 * 1000;
				break;
			case 'month':
				cutoff = now - 30 * 24 * 60 * 60 * 1000;
				break;
			case 'year':
				cutoff = now - 365 * 24 * 60 * 60 * 1000;
				break;
		}
		
		const relevantUpdates = timeframe === 'all' 
			? updates 
			: updates.filter(u => u.timestamp >= cutoff);
		
		if (relevantUpdates.length < 2) return 0;
		
		// Sort updates by timestamp ascending for frequency calculation
		const sortedUpdates = [...relevantUpdates].sort((a, b) => a.timestamp - b.timestamp);
		
		// Calculate total time span and divide by number of intervals between updates
		const timeSpan = sortedUpdates[sortedUpdates.length - 1].timestamp - sortedUpdates[0].timestamp;
		const numIntervals = sortedUpdates.length - 1;
		
		return timeSpan / numIntervals; // Average time between updates in ms
	}

	// Add a transaction to the store
	function addTransaction(tx: any, receipt: any) {
		if (!tx) return;
		
		// Only keep creation and incoming transactions
		if (!tx.to || tx.to.toLowerCase() === contractAddress.toLowerCase()) {
			const decodedInput = tx.data ? decodeInput(tx.data) : null;
			
			// Only keep transactions with successful decoding (updateTemporalNumericValuesV1 calls)
			if (decodedInput) {
				transactionStore.update(txs => {
					// Check if we already have this transaction
					if (!txs.find(t => t.hash === tx.hash)) {
						const enrichedTx = {
							...tx,
							receipt,
							decodedInput
						};
						processTransactionForStats(enrichedTx);
						return [enrichedTx, ...txs].sort((a, b) => (b.blockNumber || 0) - (a.blockNumber || 0));
					}
					return txs;
				});
			}
		}
	}

	async function fetchTransactions() {
		if (!scanTxs && !scanAssets) return;  // Don't proceed if nothing to scan
		
		loading = true;
		canceling = false;
		error = null;
		
		// Reset all stores
		resetStores();
		
		// Reset other state
		currentChainName = '';
		
		// Create new abort controller
		if (abortController) {
			abortController.abort();
		}
		abortController = new AbortController();
		
		try {
			// Fetch asset IDs first if needed
			if (scanAssets) {
				progress = 'Fetching asset IDs...';
				await fetchAssetIds();
			}
			
			progress = 'Fetching chain info...';
			const chainlistResponse = await fetch(`https://chainid.network/chains.json`);
			const chains = await chainlistResponse.json();
			const chain = chains.find((c: any) => c.chainId === parseInt(chainId));
			
			if (!chain) {
				throw new Error(`Chain ID ${chainId} not found`);
			}

			currentChainName = chain.name;
			console.log('Using chain:', chain.name);
			
			// Always fetch ABI if we're scanning anything
			if (scanTxs || scanAssets) {
				progress = 'Fetching contract ABI...';
				await fetchABI();
				// Clear progress if we're only scanning assets
				if (!scanTxs) {
					progress = '';
				}
			}
			
			// Start scanning based on options
			const promises = [];
			let txPromise: Promise<number | null> | null = null;
			
			if (scanTxs) {
				txPromise = (async () => {
					// Setup provider
					const rpcUrl = chain.rpc[0];
					const provider = new ethers.JsonRpcProvider(rpcUrl);
					
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
						const fromBlock = Math.max(0, block - chunkSize + 1); // +1 to ensure overlap
						progress = `Fetching logs for blocks ${fromBlock.toLocaleString()} to ${block.toLocaleString()} of ${latestBlock.toLocaleString()}...`;
						
						try {
							const logs = await provider.getLogs({
								address: contractAddress,
								fromBlock,
								toBlock: block
							});
							
							console.log(`Found ${logs.length} logs in range ${fromBlock}-${block}`);
							
							// Sort logs by block number descending (most recent first)
							const sortedLogs = [...logs].sort((a, b) => (b.blockNumber || 0) - (a.blockNumber || 0));
							
							const txHashes = [...new Set(sortedLogs.map(log => log.transactionHash).filter(Boolean))];
							const BATCH_SIZE = 20; // Keep small to avoid overwhelming RPC
							const batches = [];
							for (let i = 0; i < txHashes.length; i += BATCH_SIZE) {
								const batch = txHashes.slice(i, i + BATCH_SIZE);
								batches.push(batch);
							}

							let processedCount = 0;
							const totalToProcess = txHashes.length;

							for (const batch of batches) {
								let batchSuccess = false;
								let batchRetries = 0;
								let batchConsecutiveFailures = 0;
								
								while (!batchSuccess && batchRetries < 3 && !abortController?.signal.aborted) {
									try {
										progress = `Processing transactions ${processedCount + 1}-${Math.min(processedCount + batch.length, totalToProcess)} of ${totalToProcess}...`;
										const [txs, receipts] = await Promise.all([
											Promise.all(batch.map(hash => provider.getTransaction(hash))),
											Promise.all(batch.map(hash => provider.getTransactionReceipt(hash)))
										]);
										
										// Add transactions to store as they come in
										txs.forEach((tx, i) => addTransaction(tx, receipts[i]));
										
										// Check for contract creation
										for (const receipt of receipts) {
											if (receipt?.contractAddress?.toLowerCase() === contractAddress.toLowerCase()) {
												console.log('Found contract creation at block:', receipt.blockNumber);
												foundCreation = true;
												break;
											}
										}
										
										batchSuccess = true;
										batchConsecutiveFailures = 0;
										processedCount += batch.length;
									} catch (e) {
										console.warn(`Batch retry ${batchRetries + 1}/3 failed:`, e);
										batchRetries++;
										batchConsecutiveFailures++;
										if (batchConsecutiveFailures >= 50) {
											throw new Error('Too many consecutive failures (50+). The RPC endpoint might be unstable.');
										}
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
							
							// Move to next chunk, ensuring we don't skip any blocks
							block = fromBlock - 1;
							
						} catch (e: any) {
							console.warn(`Error in chunk ${fromBlock}-${block}:`, e?.message || e);
							consecutiveFailures++;
							consecutiveSuccesses = 0;
							
							if (consecutiveFailures >= 50) {
								throw new Error('Too many consecutive failures (50+). The RPC endpoint might be unstable.');
							}
							
							// Check for rate limit errors
							if (e?.message?.includes('rate') || 
								e?.message?.includes('limit') || 
								e?.message?.includes('429') ||
								e?.status === 429 ||
								e?.code === 429) {
								console.log('Rate limit hit, increasing delay...');
								retryDelay = Math.min(retryDelay * 2, 10000); // Double delay up to 10s
								progress = `${progress} (Rate limited, waiting ${(retryDelay/1000).toFixed(1)}s...)`;
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
					
					return latestBlock;
				})();
				promises.push(txPromise);
			}
			if (scanAssets) {
				promises.push(scanValues());
			}
			
			// Wait for all scans to complete
			await Promise.all(promises);
			
			// Update lastCheckedBlock if we scanned transactions
			if (txPromise) {
				lastCheckedBlock = await txPromise;
			}
			
		} catch (e: any) {
			console.error('Error in fetchTransactions:', e);
			error = e.message;
		} finally {
			loading = false;
			canceling = false;
			abortController = null;
		}
	}

	function cancelFetch() {
		if (abortController) {
			canceling = true;
			abortController.abort();
		}
	}

	// Format time ago
	function formatTimeAgo(timestamp: number): string {
		const now = Date.now();
		const diff = now - timestamp;
		
		const days = Math.floor(diff / (24 * 60 * 60 * 1000));
		const hours = Math.floor((diff % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
		const minutes = Math.floor((diff % (60 * 60 * 1000)) / (60 * 1000));
		const seconds = Math.floor((diff % (60 * 1000)) / 1000);
		const ms = diff % 1000;
		
		const parts = [];
		if (days > 0) parts.push(`${days}d`);
		if (hours > 0) parts.push(`${hours}h`);
		if (minutes > 0) parts.push(`${minutes}m`);
		if (seconds > 0) parts.push(`${seconds}s`);
		if (ms > 0 && parts.length === 0) parts.push(`${ms}ms`);
		
		return parts.join(' ') + ' ago';
	}

	// Calculate comprehensive update statistics
	function calculateUpdateStats(updates: AssetUpdate[], timeframe: 'day' | 'week' | 'month' | 'year' | 'all'): {
		averageFrequency: number;
		medianFrequency: number;
		updatesPerDay: number;
		maxGap: number;
		minGap: number;
	} {
		if (updates.length < 2) return {
			averageFrequency: 0,
			medianFrequency: 0,
			updatesPerDay: 0,
			maxGap: 0,
			minGap: 0
		};
		
		const now = Date.now();
		let cutoff = now;
		let timeframeMs = 0;
		
		switch (timeframe) {
			case 'day':
				timeframeMs = 24 * 60 * 60 * 1000;
				cutoff = now - timeframeMs;
				break;
			case 'week':
				timeframeMs = 7 * 24 * 60 * 60 * 1000;
				cutoff = now - timeframeMs;
				break;
			case 'month':
				timeframeMs = 30 * 24 * 60 * 60 * 1000;
				cutoff = now - timeframeMs;
				break;
			case 'year':
				timeframeMs = 365 * 24 * 60 * 60 * 1000;
				cutoff = now - timeframeMs;
				break;
		}
		
		const relevantUpdates = timeframe === 'all' 
			? updates 
			: updates.filter(u => u.timestamp >= cutoff);
		
		if (relevantUpdates.length < 2) return {
			averageFrequency: 0,
			medianFrequency: 0,
			updatesPerDay: 0,
			maxGap: 0,
			minGap: 0
		};
		
		// Sort updates by timestamp
		const sortedUpdates = [...relevantUpdates].sort((a, b) => a.timestamp - b.timestamp);
		
		// Calculate gaps between updates
		const gaps: number[] = [];
		for (let i = 1; i < sortedUpdates.length; i++) {
			gaps.push(sortedUpdates[i].timestamp - sortedUpdates[i-1].timestamp);
		}
		
		// Calculate statistics
		const maxGap = Math.max(...gaps);
		const minGap = Math.min(...gaps);
		
		// Calculate median gap
		const sortedGaps = [...gaps].sort((a, b) => a - b);
		const medianFrequency = sortedGaps[Math.floor(sortedGaps.length / 2)];
		
		// Calculate updates per day over the timeframe
		const timeframe_ms = timeframe === 'all'
			? sortedUpdates[sortedUpdates.length - 1].timestamp - sortedUpdates[0].timestamp
			: timeframeMs;
		
		const updatesPerDay = (relevantUpdates.length / timeframe_ms) * (24 * 60 * 60 * 1000);
		
		return {
			averageFrequency: timeframe_ms / relevantUpdates.length,
			medianFrequency,
			updatesPerDay,
			maxGap,
			minGap
		};
	}

	// Format frequency stats to human readable
	function formatFrequencyStats(stats: ReturnType<typeof calculateUpdateStats>): string {
		if (stats.averageFrequency === 0) return 'N/A';
		
		return `
			Avg: ${formatFrequency(stats.averageFrequency)}
			Median: ${formatFrequency(stats.medianFrequency)}
			Updates/day: ${stats.updatesPerDay.toFixed(1)}
			Max gap: ${formatFrequency(stats.maxGap)}
			Min gap: ${formatFrequency(stats.minGap)}
		`.trim();
	}

	// Format frequency to human readable
	function formatFrequency(ms: number): string {
		if (ms === 0) return 'N/A';
		const seconds = ms / 1000;
		if (seconds < 60) return `${seconds.toFixed(1)} seconds`;
		if (seconds < 3600) return `${(seconds / 60).toFixed(1)} minutes`;
		if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} hours`;
		return `${(seconds / 86400).toFixed(1)} days`;
	}

	// Format gas to human readable
	function formatGas(gas: number): string {
		if (gas === 0) return 'N/A';
		if (gas < 1000) return `${gas.toFixed(0)}`;
		if (gas < 1000000) return `${(gas / 1000).toFixed(1)}k`;
		return `${(gas / 1000000).toFixed(1)}M`;
	}

	async function refreshTransactions() {
		if (!lastCheckedBlock || (!scanTxs && !scanAssets)) return;
		
		loading = true;
		canceling = false;
		error = null;
		
		// Create new abort controller
		if (abortController) {
			abortController.abort();
		}
		abortController = new AbortController();
		
		try {
			// Setup provider
			const chainlistResponse = await fetch(`https://chainid.network/chains.json`);
			const chains = await chainlistResponse.json();
			const chain = chains.find((c: any) => c.chainId === parseInt(chainId));
			
			if (!chain) {
				throw new Error(`Chain ID ${chainId} not found`);
			}
			
			const rpcUrl = chain.rpc[0];
			const provider = new ethers.JsonRpcProvider(rpcUrl);
			
			// Only get latest block if we're scanning transactions
			let latestBlock = lastCheckedBlock;
			if (scanTxs) {
				progress = 'Getting latest block...';
				latestBlock = await provider.getBlockNumber();
				console.log('Latest block:', latestBlock);
				
				if (latestBlock <= lastCheckedBlock) {
					progress = 'Already up to date!';
					return;
				}
			}
			
			// Start scanning based on options
			const promises = [];
			if (scanTxs) {
				promises.push((async () => {
					// ... rest of transaction refresh code ...
					return latestBlock;
				})());
			}
			if (scanAssets) {
				promises.push(scanValues());
			}
			
			// Wait for all scans to complete
			await Promise.all(promises);
			
			// Update lastCheckedBlock only if we scanned transactions
			if (scanTxs) {
				lastCheckedBlock = latestBlock;
			}
			
		} catch (e: any) {
			console.error('Error in refreshTransactions:', e);
			error = e.message;
		} finally {
			loading = false;
			canceling = false;
			abortController = null;
		}
	}

	// Scan current values for all assets
	async function scanValues() {
		if (!contractAddress || !chainId) return;
		
		scanningValues = true;
		scanProgress.set('Preparing to scan values...');
		
		try {
			// Setup provider
			const chainlistResponse = await fetch(`https://chainid.network/chains.json`);
			const chains = await chainlistResponse.json();
			const chain = chains.find((c: any) => c.chainId === parseInt(chainId));
			
			if (!chain) {
				throw new Error(`Chain ID ${chainId} not found`);
			}
			
			const rpcUrl = chain.rpc[0];
			const provider = new ethers.JsonRpcProvider(rpcUrl);
			
			if (!contractInterface) {
				throw new Error('Contract interface not loaded');
			}
			
			const contract = new ethers.Contract(contractAddress, contractInterface, provider);
			
			// Clear previous values
			assetValues.set(new Map());
			
			// Process assets in batches to avoid rate limits
			const assets = [...assetIdMap.entries()];
			const BATCH_SIZE = 5;
			const batches = [];
			const MAX_RETRIES = 5;  // Maximum number of retries per asset
			
			for (let i = 0; i < assets.length; i += BATCH_SIZE) {
				batches.push(assets.slice(i, i + BATCH_SIZE));
			}
			
			let processedCount = 0;
			const totalAssets = assets.length;
			const failedScans: [string, string][] = [];  // Store failed scans for retry
			
			for (const batch of batches) {
				// Check if cancelled
				if (abortController?.signal.aborted) {
					console.log('Asset scanning cancelled');
					break;
				}

				const batchResults = await Promise.all(batch.map(async ([hash, name]) => {
					try {
						const result = await contract.getTemporalNumericValueUnsafeV1(hash);
						const value = Number(result.quantizedValue) / 1e18;
						const timestamp = Number(result.timestampNs) / 1_000_000;
						
						return [hash, {
							value,
							timestamp,
							found: true
						}] as const;
					} catch (e: any) {
						// Check if this is a "revert" error (valid "not found" response)
						if (e?.error?.data?.message?.includes('NotFound') || 
							e?.data?.message?.includes('NotFound') ||
							e?.message?.includes('NotFound')) {
							console.log(`Asset ${name} not found (valid response)`);
							return [hash, {
								value: 0,
								timestamp: 0,
								found: false
							}] as const;
						}
						
						// For other errors (RPC/network issues), add to retry queue
						console.warn(`Error scanning asset ${hash}:`, e);
						failedScans.push([hash, name]);
						return [hash, {
							value: 0,
							timestamp: 0,
							found: false
						}] as const;
					}
				}));
				
				// Update store with batch results
				assetValues.update(map => {
					const newMap = new Map(map);
					for (const [hash, value] of batchResults) {
						newMap.set(hash, value);
					}
					// Force a resort by updating the sort state with the same values
					sortState.update(state => ({ ...state }));
					return newMap;
				});
				
				processedCount += batch.length;
				scanProgress.set(`Scanning values... ${processedCount}/${totalAssets} assets processed`);
				
				// Add a small delay between batches to avoid rate limits
				await new Promise(resolve => setTimeout(resolve, 100));
			}
			
			// Retry failed scans if not cancelled
			if (failedScans.length > 0 && !abortController?.signal.aborted) {
				scanProgress.set(`Retrying failed scans (0/${failedScans.length})...`);
				
				let retryProgress = 0;
				for (const [hash, name] of failedScans) {
					// Check if cancelled before each retry
					if (abortController?.signal.aborted) {
						console.log('Retry scanning cancelled');
						break;
					}

					let retryCount = 0;
					let success = false;
					
					while (retryCount < MAX_RETRIES && !success && !abortController?.signal.aborted) {
						try {
							const result = await contract.getTemporalNumericValueUnsafeV1(hash);
							const value = Number(result.quantizedValue) / 1e18;
							const timestamp = Number(result.timestampNs) / 1_000_000;
							
							// Update store with successful retry
							assetValues.update(map => {
								const newMap = new Map(map);
								newMap.set(hash, {
									value,
									timestamp,
									found: true
								});
								// Force a resort
								sortState.update(state => ({ ...state }));
								return newMap;
							});
							
							success = true;
							console.log(`Successfully retried scan for ${name} on attempt ${retryCount + 1}`);
						} catch (e: any) {
							if (e?.error?.data?.message?.includes('NotFound') || 
							e?.data?.message?.includes('NotFound') ||
							e?.message?.includes('NotFound')) {
								console.log(`Asset ${name} not found (valid response)`);

								assetValues.update(map => {
									const newMap = new Map(map);
									newMap.set(hash, {
										value: 0,
										timestamp: 0,
										found: false
									});
									return newMap;
								});
								success = true;
								console.log(`Successfully retried scan for ${name} on attempt ${retryCount + 1}`);
							}
							else {
								console.warn(`Retry ${retryCount + 1} failed for ${name}:`, e);
								console.warn('Error details:', e?.message || 'Unknown error');
								if (e?.error?.message) console.warn('Provider error:', e.error.message);
								if (e?.error?.data) console.warn('Error data:', e.error.data);
								
								retryCount++;
								if (retryCount < MAX_RETRIES && !abortController?.signal.aborted) {
									scanProgress.set(`Retry ${retryCount + 1}/${MAX_RETRIES} for ${name} (${retryProgress + 1}/${failedScans.length}) (${e?.message || 'Unknown error'})...`);
									await new Promise(resolve => setTimeout(resolve, 1000));  // 1 second delay between retries
								} else if (retryCount >= MAX_RETRIES) {
									// Mark as failed after all retries are exhausted
									assetValues.update(map => {
										const newMap = new Map(map);
										newMap.set(hash, {
											value: 0,
											timestamp: 0,
											found: false,
											failed: true
										});
										return newMap;
									});
								}
							}
						}
						retryProgress++;
						scanProgress.set(`Retrying failed scans (${retryProgress}/${failedScans.length})...`);
					}
				}
			}
			
		} catch (e: any) {
			console.error('Error scanning values:', e);
			if (!error) error = e.message;  // Only set error if no other error exists
		} finally {
			scanningValues = false;
			scanProgress.set('');
		}
	}

	// Sort function for value scanning table
	function sortAssets(assets: [string, string][], sortState: { column: string | null, direction: 'asc' | 'desc' }): [string, string][] {
		if (!sortState.column) return assets;
		
		return [...assets].sort((a, b) => {
			const [hashA, nameA] = a;
			const [hashB, nameB] = b;
			const valueA = $assetValues.get(hashA);
			const valueB = $assetValues.get(hashB);
			
			let comparison = 0;
			switch (sortState.column) {
				case 'asset':
					comparison = nameA.localeCompare(nameB);
					break;
				case 'status':
					// Failed (-2), Not scanned (-1), Not found (0), Found (1)
					const statusA = !valueA ? -1 : (valueA.failed ? -2 : (valueA.found ? 1 : 0));
					const statusB = !valueB ? -1 : (valueB.failed ? -2 : (valueB.found ? 1 : 0));
					comparison = statusA - statusB;
					// If status is the same, sort by asset name
					if (comparison === 0) {
						comparison = nameA.localeCompare(nameB);
					}
					break;
				case 'value':
					if (!valueA?.found && !valueB?.found) {
						comparison = nameA.localeCompare(nameB);
					} else if (!valueA?.found) {
						comparison = 1;  // Move not found to bottom
					} else if (!valueB?.found) {
						comparison = -1; // Move not found to bottom
					} else {
						comparison = valueA.value - valueB.value;
						// If values are equal, sort by asset name
						if (comparison === 0) {
							comparison = nameA.localeCompare(nameB);
						}
					}
					break;
				case 'timestamp':
					if (!valueA?.found && !valueB?.found) {
						comparison = nameA.localeCompare(nameB);
					} else if (!valueA?.found) {
						comparison = 1;  // Move not found to bottom
					} else if (!valueB?.found) {
						comparison = -1; // Move not found to bottom
					} else {
						comparison = valueA.timestamp - valueB.timestamp;
						// If timestamps are equal, sort by asset name
						if (comparison === 0) {
							comparison = nameA.localeCompare(nameB);
						}
					}
					break;
			}
			
			return sortState.direction === 'asc' ? comparison : -comparison;
		});
	}

	let filteredAndSortedAssets: [string, string][] = [];

	$: {
		// This will re-run whenever assetIdMap, valueSearchQuery, sortState, or assetValues changes
		const filtered = [...assetIdMap.entries()]
			.filter(([hash, name]) => {
				const matchesSearch = !valueSearchQuery || 
					name.toLowerCase().includes(valueSearchQuery.toLowerCase());
				
				if (!showOnlyFound) return matchesSearch;
				
				const value = $assetValues.get(hash);
				return matchesSearch && value?.found;
			});
		filteredAndSortedAssets = sortAssets(filtered, $sortState);
	}

	function toggleSort(column: typeof $sortState.column) {
		sortState.update(state => {
			if (state.column === column) {
				return { ...state, direction: state.direction === 'asc' ? 'desc' : 'asc' };
			} else {
				return { column, direction: 'asc' };
			}
		});
	}
</script>

<div class="container mx-auto p-4 space-y-8">
	{#if currentChainName}
		<div class="card p-4">
			<h4 class="h4"><strong>Chain:</strong> {currentChainName}</h4>
		</div>
	{/if}
	
	<div class="card p-4">
		<form class="space-y-4" on:submit|preventDefault={fetchTransactions}>
			<div class="space-y-2">
				<label class="label" for="chainId">
					<div class="flex items-center gap-2">
						<span>Chain ID</span>
						<div class="relative group">
							<div class="text-surface-500 dark:text-surface-300 cursor-help">
								<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<circle cx="12" cy="12" r="10"></circle>
									<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
									<line x1="12" y1="17" x2="12.01" y2="17"></line>
								</svg>
							</div>
							<div class="absolute left-full ml-2 top-1/2 -translate-y-1/2 p-1.5 bg-surface-700 text-white rounded shadow-lg opacity-0 group-hover:opacity-100 transition-opacity z-50 whitespace-nowrap text-sm">
								<a href="https://chainlist.org" target="_blank" rel="noopener noreferrer" class="text-primary-300 hover:underline">
									EVM Chain IDs can be found at chainlist.org
								</a>
							</div>
						</div>
					</div>
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
					<div class="flex items-center gap-2">
						<span>Contract Address</span>
						<div class="relative group">
							<div class="text-surface-500 dark:text-surface-300 cursor-help">
								<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
									<circle cx="12" cy="12" r="10"></circle>
									<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
									<line x1="12" y1="17" x2="12.01" y2="17"></line>
								</svg>
							</div>
							<div class="absolute left-full ml-2 top-1/2 -translate-y-1/2 p-1.5 bg-surface-700 text-white rounded shadow-lg opacity-0 group-hover:opacity-100 transition-opacity z-50 whitespace-nowrap text-sm">
								<a href="https://docs.stork.network/resources/contract-addresses/evm" target="_blank" rel="noopener noreferrer" class="text-primary-300 hover:underline">
									Stork contract addresses can be found in the Stork docs 
								</a>
							</div>
						</div>
					</div>
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

			<div class="flex flex-row gap-2">
				<label class="flex items-center gap-2">
					<input type="checkbox" bind:checked={scanTxs} />
					<span class="text-sm">TX History</span>
				</label>
				<label class="flex items-center gap-2">
					<input type="checkbox" bind:checked={scanAssets} />
					<span class="text-sm">Current Values</span>
				</label>
			</div>

			<div class="flex flex-col sm:flex-row gap-4">
				<button type="submit" class="btn variant-filled-primary w-full sm:w-auto" disabled={loading || (!scanTxs && !scanAssets)}>
					{loading ? 'Loading...' : 'Scan'}
				</button>
				{#if loading}
					<button type="button" class="btn variant-filled-error w-full sm:w-auto" disabled={canceling} on:click={cancelFetch}>
						{#if canceling}
							<div class="flex items-center gap-2 justify-center">
								<div class="spinner-border !w-4 !h-4 !border-2"></div>
								<span>Stopping...</span>
							</div>
						{:else}
							Stop	
						{/if}
					</button>
				{:else if lastCheckedBlock !== null}
					<button type="button" class="btn variant-filled-primary w-full sm:w-auto" disabled={!scanTxs && !scanAssets} on:click={refreshTransactions}>
						<div class="flex items-center gap-2 justify-center">
							<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<path d="M21 2v6h-6"></path>
								<path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path>
								<path d="M3 22v-6h6"></path>
								<path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path>
							</svg>
							<span>Refresh</span>
						</div>
					</button>
				{/if}
			</div>
		</form>
	</div>
	
	{#if loading}
		<div class="card p-4">
			<div class="flex items-center space-x-4">
				<div class="spinner-border" role="status"></div>
				<div class="space-y-1">
					{#if progress}
						<div>{progress.startsWith('Found ') ? '✓' : '🔍'} {progress}</div>
					{/if}
					{#if progress.includes('Rate limited')}
						<div class="text-warning-500">⚠️ Rate limit hit, slowing down requests...</div>
					{/if}
					{#if scanningValues && $scanProgress}
						<div class="text-info-500">{$scanProgress.includes('Scanning values... ') || $scanProgress.includes('Retrying failed') ? '🔍' : '✓'} {$scanProgress}</div>
					{/if}
				</div>
			</div>
		</div>
	{/if}
	
	{#if error}
		<div class="alert variant-filled-error">
			{error}
		</div>
	{/if}
	
	<!-- View Selector Tabs -->
	<TabGroup justify="justify-center">
		<Tab bind:group={currentView} name="transactions" value="transactions">
			<span class="flex items-center gap-2">
				<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"></polyline>
					<path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>
				</svg>
				<span>Transaction History</span>
			</span>
		</Tab>
		<Tab bind:group={currentView} name="values" value="values">
			<span class="flex items-center gap-2">
				<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
					<polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
					<line x1="12" y1="22.08" x2="12" y2="12"></line>
				</svg>
				<span>Current Values</span>
			</span>
		</Tab>
	</TabGroup>
	
	{#if currentView === 'transactions'}
		{#if $transactionStore.length === 0 && !error}
			<div class="card p-4">
				<div class="text-center text-gray-500">
					No transactions found for {currentChainName || 'this contract'}.
				</div>
			</div>
		{/if}
		
		{#if $transactionStore.length > 0}
			<div class="space-y-8">
				<!-- Aggregate Stats -->
				<div class="card p-4">
					<div class="flex justify-between items-center mb-4">
						<h3 class="h3">Network Overview</h3>
						<button class="btn btn-sm variant-filled-primary" on:click={() => $showDetails.network = !$showDetails.network}>
							{$showDetails.network ? 'Hide' : 'Show'} Details
						</button>
					</div>
					<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
						<!-- Total Assets -->
						<div class="card variant-soft p-4">
							<div class="text-2xl font-bold">{$assetStatsStore.size}</div>
							<div class="text-sm">Total Assets</div>
							{#if $showDetails.network}
								<div class="mt-4">
									<div class="font-semibold mb-2">Asset List:</div>
									<div class="table-container max-h-48 overflow-y-auto">
										<table class="table table-compact">
											<tbody>
												{#each [...$assetStatsStore.keys()] as assetName}
													<tr>
														<td>{assetName}</td>
													</tr>
												{/each}
											</tbody>
										</table>
									</div>
								</div>
							{/if}
						</div>

						<!-- Total Updates -->
						<div class="card variant-soft p-4">
							<div class="text-2xl font-bold">{$aggregateStatsStore.totalUpdates}</div>
							<div class="text-sm">Total Updates</div>
							<div class="text-sm text-surface-400">
								{formatGas($aggregateStatsStore.totalGas)} gas used
							</div>
							{#if $showDetails.network}
								<div class="mt-4">
									<div class="font-semibold mb-2">Transaction Details:</div>
									<div class="text-sm mb-2">
										Unique Transactions: {new Set($transactionStore.map(tx => tx.hash)).size}
									</div>
									<div class="table-container max-h-48 overflow-y-auto">
										<table class="table table-compact">
											<tbody>
												{#each $transactionStore as tx}
													<tr>
														<td class="font-mono text-xs break-all">{tx.hash}</td>
													</tr>
												{/each}
											</tbody>
										</table>
									</div>
								</div>
							{/if}
						</div>

						<!-- Unique Updaters -->
						<div class="card variant-soft p-4">
							<div class="text-2xl font-bold">{$aggregateStatsStore.totalUniqueUpdaters.size}</div>
							<div class="text-sm">Unique Updaters</div>
							<div class="text-sm text-surface-400">
								{formatGas($aggregateStatsStore.totalGas / $aggregateStatsStore.totalUniqueUpdaters.size)} gas/updater
							</div>
							{#if $showDetails.network}
								<div class="mt-4">
									<div class="font-semibold mb-2">Updater List:</div>
									<div class="table-container max-h-48 overflow-y-auto">
										<table class="table table-compact">
											<tbody>
												{#each [...$aggregateStatsStore.totalUniqueUpdaters] as address}
													<tr>
														<td>
															<div class="font-mono text-xs break-all">{address}</div>
															{#if $aggregateStatsStore.updaterGasStats.get(address)}
																<div class="text-surface-400">
																	Gas: {formatGas($aggregateStatsStore.updaterGasStats.get(address)?.totalGas || 0)}
																	({formatGas($aggregateStatsStore.updaterGasStats.get(address)?.averageGas || 0)}/update)
																</div>
															{/if}
														</td>
													</tr>
												{/each}
											</tbody>
										</table>
									</div>
								</div>
							{/if}
						</div>
					</div>
				</div>

				<!-- Timeframe Selector -->
				<div class="card p-4">
					<label class="label">
						<span>Update Frequency Timeframe</span>
						<select
							class="select"
							bind:value={selectedTimeframe}
						>
							<option value="day">Last 24 Hours</option>
							<option value="week">Last Week</option>
							<option value="month">Last Month</option>
							<option value="year">Last Year</option>
							<option value="all">All Time</option>
						</select>
					</label>
				</div>

				<!-- Asset List -->
				<div class="space-y-4">
					{#each [...$assetStatsStore.entries()] as [assetId, stats]}
						<div class="card p-4">
							<div class="flex items-center justify-between mb-4">
								<h3 class="h3">{stats.assetName}</h3>
								<div class="flex items-center gap-4">
									<div class="badge variant-filled">{stats.updateCount} updates</div>
									<button class="btn btn-sm variant-filled-primary" on:click={() => {
										showDetails.update(details => {
											const newAssets = new Map(details.assets);
											const currentDetails = newAssets.get(assetId) || { shown: false, showHashes: false };
											newAssets.set(assetId, { ...currentDetails, shown: !currentDetails.shown });
											return { ...details, assets: newAssets };
										});
									}}>
										{$showDetails.assets.get(assetId)?.shown ? 'Hide' : 'Show'} Details
									</button>
								</div>
							</div>
							
							<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
								<!-- Last Update -->
								<div class="card variant-soft p-4">
									<div class="text-sm font-semibold mb-2">Last Update</div>
									{#if stats.lastUpdate}
										<div>Value: {stats.lastUpdate.value}</div>
										<div class="text-sm">{new Date(stats.lastUpdate.timestamp).toLocaleString()}</div>
										<div class="text-sm text-surface-400">{formatTimeAgo(stats.lastUpdate.timestamp)}</div>
									{:else}
										<div>No updates yet</div>
									{/if}
								</div>
								
								<!-- Update Frequency -->
								<div class="card variant-soft p-4">
									<div class="text-sm font-semibold mb-2 flex items-center gap-2">
										<span>Update Statistics</span>
										<div class="relative group">
											<div class="text-surface-500 cursor-help">
												<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
													<circle cx="12" cy="12" r="10"></circle>
													<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
													<line x1="12" y1="17" x2="12.01" y2="17"></line>
												</svg>
											</div>
											<div class="absolute left-full ml-2 top-1/2 -translate-y-1/2 p-1.5 bg-surface-700 text-white rounded shadow-lg opacity-0 group-hover:opacity-100 transition-opacity z-50 whitespace-nowrap text-sm">
												Statistics calculated over the selected time period
											</div>
										</div>
									</div>
									<div class="text-sm space-y-1">
										{#if stats.updates.length > 0}
											{@const updateStats = calculateUpdateStats(stats.updates, selectedTimeframe)}
											<div>Updates/day: {updateStats.updatesPerDay.toFixed(1)}</div>
											<div>Average gap: {formatFrequency(updateStats.averageFrequency)}</div>
											{#if $showDetails.assets.get(assetId)?.shown}
												<div>Median gap: {formatFrequency(updateStats.medianFrequency)}</div>
												<div>Min gap: {formatFrequency(updateStats.minGap)}</div>
												<div>Max gap: {formatFrequency(updateStats.maxGap)}</div>
											{/if}
										{:else}
											<div>No updates in selected timeframe</div>
										{/if}
									</div>
								</div>
								
								<!-- Unique Updaters -->
								<div class="card variant-soft p-4">
									<div class="text-sm font-semibold mb-2">Unique Updaters</div>
									<div>{stats.uniqueUpdaters.size}</div>
									{#if $showDetails.assets.get(assetId)?.shown}
										<div class="mt-4 space-y-1 max-h-48 overflow-y-auto text-sm">
											<div class="table-container">
												<table class="table table-compact">
													<tbody>
														{#each [...stats.uniqueUpdaters] as address}
															<tr>
																<td>
																	<div class="font-mono text-xs break-all">{address}</div>
																	{#if stats.updaterGasStats.get(address)}
																		<div class="text-surface-400">
																			Gas: {formatGas(stats.updaterGasStats.get(address)?.totalGas || 0)}
																			({formatGas(stats.updaterGasStats.get(address)?.averageGas || 0)}/update)
																		</div>
																	{/if}
																</td>
															</tr>
														{/each}
													</tbody>
												</table>
											</div>
										</div>
									{/if}
								</div>
								
								<!-- Update Count -->
								<div class="card variant-soft p-4">
									<div class="text-sm font-semibold mb-2">Total Updates</div>
									<div>{stats.updateCount}</div>
									<div class="text-sm text-surface-400">
										{formatGas(stats.totalGas)} gas used
										({formatGas(stats.totalGas / stats.updateCount)}/update)
									</div>
									{#if $showDetails.assets.get(assetId)?.shown}
										<div class="mt-4">
											<div class="flex justify-between items-center mb-2">
												<div class="text-sm font-semibold">Updates:</div>
												<button class="btn btn-sm variant-glass-primary" on:click={() => {
													showDetails.update(details => {
														const newAssets = new Map(details.assets);
														const currentDetails = newAssets.get(assetId) || { shown: true, showHashes: false };
														newAssets.set(assetId, { ...currentDetails, showHashes: !currentDetails.showHashes });
														return { ...details, assets: newAssets };
													});
												}}>
													Show {$showDetails.assets.get(assetId)?.showHashes ? 'Values' : 'Tx Hashes'}
												</button>
											</div>
											<div class="table-container max-h-48 overflow-y-auto">
												<table class="table table-compact">
													<tbody>
														{#if $showDetails.assets.get(assetId)?.showHashes}
															{#each stats.updates.sort((a, b) => b.timestamp - a.timestamp) as update}
																<tr>
																	<td>
																		<div class="font-mono text-xs break-all">{update.txHash}</div>
																		<div class="text-surface-400">Gas: {formatGas(update.gasUsed)}</div>
																	</td>
																</tr>
															{/each}
														{:else}
															{#each stats.updates.sort((a, b) => b.timestamp - a.timestamp) as update}
																<tr>
																	<td>
																		<div>Value: {update.value}</div>
																		<div>{new Date(update.timestamp).toLocaleString()}</div>
																		<div class="text-surface-400">
																			{formatTimeAgo(update.timestamp)}
																			• Gas: {formatGas(update.gasUsed)}
																		</div>
																	</td>
																</tr>
															{/each}
														{/if}
													</tbody>
												</table>
											</div>
										</div>
									{/if}
								</div>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	{:else}
		<!-- Value Scanning View -->
		<div class="space-y-4">
			<div class="card p-4">
				<div class="flex justify-between items-center gap-4">
					<div class="flex-1">
						<input
							type="text"
							class="input w-full"
							placeholder="Search assets..."
							bind:value={valueSearchQuery}
						/>
					</div>
					<label class="flex items-center gap-2 whitespace-nowrap">
						<input
							type="checkbox"
							bind:checked={showOnlyFound}
						/>
						<span class="text-sm">Show only found assets</span>
					</label>
				</div>
			</div>

			<!-- Results Table -->
			<div class="card p-4">
				<div class="table-container">
					<table class="table table-compact">
						<thead>
							<tr>
								<th>
									<button class="flex items-center gap-2" on:click={() => toggleSort('asset')}>
										Asset
										{#if $sortState.column === 'asset'}
											<span class="text-primary-500">
												{#if $sortState.direction === 'asc'}
													↑
												{:else}
													↓
												{/if}
											</span>
										{/if}
									</button>
								</th>
								<th>
									<button class="flex items-center gap-2" on:click={() => toggleSort('status')}>
											Status
										{#if $sortState.column === 'status'}
											<span class="text-primary-500">
												{#if $sortState.direction === 'asc'}
													↑
												{:else}
													↓
												{/if}
											</span>
										{/if}
									</button>
								</th>
								<th>
									<button class="flex items-center gap-2" on:click={() => toggleSort('value')}>
										Latest Value
										{#if $sortState.column === 'value'}
											<span class="text-primary-500">
												{#if $sortState.direction === 'asc'}
													↑
												{:else}
													↓
												{/if}
											</span>
										{/if}
									</button>
								</th>
								<th>
									<button class="flex items-center gap-2" on:click={() => toggleSort('timestamp')}>
										Timestamp
										{#if $sortState.column === 'timestamp'}
											<span class="text-primary-500">
												{#if $sortState.direction === 'asc'}
													↑
												{:else}
													↓
												{/if}
											</span>
										{/if}
									</button>
								</th>
								<th>Age</th>
							</tr>
						</thead>
						<tbody>
							{#if filteredAndSortedAssets.length === 0}
								<tr>
									<td colspan="5" class="text-center text-gray-500 py-4">
										No {showOnlyFound ? 'found ' : ''}assets{valueSearchQuery ? ' matching search' : ''}.
									</td>
								</tr>
							{:else}
								{#each filteredAndSortedAssets as [hash, name]}
									{@const value = $assetValues.get(hash)}
									<tr>
										<td data-label="Asset">{name}</td>
										<td data-label="Status">
											{#if value === undefined}
												<span class="badge variant-ghost">Not Scanned</span>
											{:else if value.found}
												<span class="badge variant-filled-success">✓ Found</span>
											{:else if value.failed}
												<span class="badge variant-filled-warning">⚠ Failed</span>
											{:else}
												<span class="badge variant-filled-error">✗ Not Found</span>
											{/if}
										</td>
										<td data-label="Latest Value">
											{#if value?.found}
												{value.value}
											{:else}
												-
											{/if}
										</td>
										<td data-label="Timestamp">
											{#if value?.found}
												{new Date(value.timestamp).toLocaleString()}
											{:else}
												-
											{/if}
										</td>
										<td data-label="Age">
											{#if value?.found}
												{formatTimeAgo(value.timestamp)}
											{:else}
												-
											{/if}
										</td>
									</tr>
								{/each}
							{/if}
						</tbody>
					</table>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.table-container {
		@apply overflow-x-auto;
	}
	
	.spinner-border {
		@apply w-8 h-8 border-4 border-primary-900 border-r-transparent rounded-full animate-spin;
	}

	/* Sort button styles */
	th button {
		@apply w-full font-bold hover:text-primary-500 transition-colors;
	}

	th button span {
		@apply font-bold text-lg leading-none;
	}

	/* Table styles with dark mode support */
	.table-container table {
		@apply border-secondary-500;
	}

	.table-container th,
	.table-container td {
		@apply border-secondary-500;
	}

	.card {
		@apply border border-secondary-500;
	}

	:global(.dark) .table-container table {
		@apply border-primary-900 bg-surface-700;
	}

	:global(.dark) .table-container th {
		@apply border-primary-900 bg-surface-800;
	}

	:global(.dark) .table-container td {
		@apply border-primary-900 bg-surface-700;
	}

	:global(.dark) .table-container tr:nth-child(even) td {
		@apply bg-surface-800;
	}

	:global(.dark) .card {
		@apply border border-primary-900;
	}

	/* Responsive table styles */
	@media (max-width: 640px) {
		.table-container table {
			@apply w-full;
		}

		.table-container th,
		.table-container td {
			@apply block w-full;
		}

		.table-container tr {
			@apply block border-b border-secondary-500 mb-4;
		}

		:global(.dark) .table-container tr {
			@apply border-primary-900;
		}

		.table-container td {
			@apply pl-[8rem] relative;
		}

		.table-container td::before {
			content: attr(data-label);
			@apply absolute left-4 font-semibold;
		}

		/* Hide table headers on mobile */
		.table-container thead {
			@apply hidden;
		}
	}
</style>

