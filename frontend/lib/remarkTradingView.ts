import type { Link, Root, RootContent, Table, Text } from 'mdast';
import { buildTradingViewChartUrl, chartSymbolForCell, stockIdentityForColumns, tradingViewMentions } from './tradingview';

function cellText(node: RootContent): string | null {
  if (node.type === 'text') return node.value;
  if (!['tableCell','strong','emphasis','delete'].includes(node.type) || !('children' in node)) return null;
  const parts = node.children.map(cellText);
  return parts.includes(null) ? null : parts.join('');
}

function linkTableIdentities(table: Table) {
  const [header, ...rows] = table.children;
  if (!header) return;
  const columns = header.children.map(cell => cellText(cell) ?? '');
  for (const row of rows) {
    const values = row.children.map(cellText);
    const identity = stockIdentityForColumns(columns,values);
    row.children.forEach((cell,index) => {
      const value = values[index];
      if (!value) return;
      const symbol = chartSymbolForCell(columns[index] ?? '',value,identity);
      const url = symbol && buildTradingViewChartUrl({symbol,exchange:identity.exchange,market:'us'});
      if (url) cell.children = [{type:'link',url,children:cell.children}];
    });
  }
}

// Operate on parsed Markdown so explicit links, images and code keep their semantics.
export function remarkTradingView() {
  return (root: Root) => {
    function transform(nodes: RootContent[]): RootContent[] {
      return nodes.flatMap((node): RootContent[] => {
        if (node.type === 'link' || node.type === 'linkReference') return [node];
        if (node.type === 'table') linkTableIdentities(node);
        if (node.type === 'text') {
          const mentions = tradingViewMentions(node.value);
          if (!mentions.length) return [node];
          const parts: (Text | Link)[] = [];
          let start = 0;
          for (const mention of mentions) {
            const url = buildTradingViewChartUrl({symbol: mention.symbol, market: 'us'});
            if (!url) continue;
            parts.push({type:'text',value:node.value.slice(start,mention.start)},
              {type:'link',url,children:[{type:'text',value:mention.symbol}]});
            start = mention.end;
          }
          return [...parts, {type:'text',value:node.value.slice(start)}];
        }
        if ('children' in node) return [{...node, children:transform(node.children)} as RootContent];
        return [node];
      });
    }
    root.children = transform(root.children);
  };
}
