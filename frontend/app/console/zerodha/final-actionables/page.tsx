import Link from 'next/link';
import {ConceptFAdvisoryHistory} from '@/components/workspace/ConceptFAdvisoryHistory';
import { FinalActionablesConsole } from '@/app/console/_components/FinalActionablesConsole';

export default function ZerodhaFinalActionablesPage() {
  return process.env.NEXT_PUBLIC_UAT2==='true'?<><Link className="inline-block rounded border p-3" href="/console/zerodha/final-actionables/calculation-sheet">Open current-formula calculation sheet →</Link><ConceptFAdvisoryHistory/></>:<FinalActionablesConsole portfolio="zerodha" market="india" />;
}
