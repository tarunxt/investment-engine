import {PersonalUsage} from '@/components/account/PersonalUsage';
import {currentAdministrator} from '../_components/adminAccess';
import AdminApiUsage from './AdminApiUsage';
import LlmUsageBreakdown from './_components/LlmUsageBreakdown';
export default async function ApisPage(){
 if(!await currentAdministrator())return <PersonalUsage/>;
 return <><AdminApiUsage/><LlmUsageBreakdown/></>;
}
