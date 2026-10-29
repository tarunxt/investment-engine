import {ConceptFPromptLibrary} from '@/components/workspace/ConceptFPromptLibrary';
export default function ResearchLibraryPage(){return process.env.NEXT_PUBLIC_UAT2==='true'?<ConceptFPromptLibrary/>:<p>The governed simulation research library is available only in its UAT2 workspace.</p>;}
