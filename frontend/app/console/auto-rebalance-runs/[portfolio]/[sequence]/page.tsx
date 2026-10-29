"use client";
import {useParams} from 'next/navigation';
import {admittedHistoryRoute} from '@/lib/historyRoute';
import {AutoRebalanceHistoryDetailClient} from '../../_components/AutoRebalanceHistoryClient';
export default function AutoRebalanceRunDetailPage(){
 const params=useParams<{portfolio:string;sequence:string}>();
 const route=admittedHistoryRoute(params.portfolio,params.sequence);
 if(!route)return <p role="alert">Exact canonical history route required. No alternative market or record requested.</p>;
 return <AutoRebalanceHistoryDetailClient key={`${route.portfolio}:${route.sequence}`} portfolio={route.portfolio} sequence={route.sequence}/>;
}
