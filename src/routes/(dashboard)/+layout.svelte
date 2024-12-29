<script lang="ts">
	import { AppShell, AppBar } from '@skeletonlabs/skeleton';
	import { LightSwitch } from '@skeletonlabs/skeleton';
	import { page } from '$app/stores';
</script>

<AppShell>
	<svelte:fragment slot="header">
		<AppBar class="px-4 sm:px-8">
			<svelte:fragment slot="lead">
				<div class="flex items-center gap-y-4 gap-x-2">
					<img src="/stork-dark-on-light.png" alt="Stork" class="h-12 w-12" />
					<span class="text-xl font-serif hidden md:block">Stork</span>
				</div>
			</svelte:fragment>
			<svelte:fragment slot="default">
				<nav class="flex justify-center">
					<a 
						href="/" 
						class="tab {$page.url.pathname === '/' ? 'tab-active' : ''}"
						data-testid="tab-dashboard"
					>
						Chain Analytics
					</a>
					<a 
						href="/assets" 
						class="tab {$page.url.pathname === '/assets' ? 'tab-active' : ''}"
						data-testid="tab-assets"
					>
						Assets
					</a>
				</nav>
			</svelte:fragment>
			<svelte:fragment slot="trail">
				<div class="flex items-center gap-4">
					<div class="border-l border-surface-500/30 h-6"></div>
					<LightSwitch />
				</div>
			</svelte:fragment>
		</AppBar>
	</svelte:fragment>
	<!-- Page Route Content -->
	<slot />
</AppShell>

<style>
	.tab {
		@apply px-4 py-2 font-medium;
		@apply border-b-2 border-transparent;
		@apply hover:border-secondary-500/30 transition-colors;
		@apply dark:hover:border-primary-500/30;
	}
	
	.tab-active {
		@apply border-secondary-500;
		@apply hover:border-secondary-500;
		@apply dark:border-primary-500;
		@apply dark:hover:border-primary-500;
	}
</style>