<script lang="ts">
  import { keccak256 } from 'ethereum-cryptography/keccak';
  import { utf8ToBytes } from 'ethereum-cryptography/utils';
  import type { PageData } from './$types';

  export let data: PageData;
  const { assets } = data;

  function encodeAssetId(assetId: string): string {
    const bytes = utf8ToBytes(assetId);
    const hash = keccak256(bytes);
    return '0x' + Buffer.from(hash).toString('hex');
  }
</script>

<div class="p-4">
  <table class="w-full border-collapse border-primary-token">
    <thead>
      <tr>
        <th class="p-2 text-left bg-gray-100 border border-gray-300">Asset ID</th>
        <th class="p-2 text-left bg-gray-100 border border-gray-300">Encoded Asset ID</th>
      </tr>
    </thead>
    <tbody>
      {#each assets as asset}
        <tr class="hover:bg-gray-50">
          <td class="p-2 border border-gray-300">{asset}</td>
          <td class="p-2 border border-gray-300 font-mono">{encodeAssetId(asset)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
