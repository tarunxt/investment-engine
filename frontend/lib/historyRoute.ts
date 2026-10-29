export function admittedHistoryRoute(portfolio:unknown,sequence:unknown):{portfolio:'zerodha'|'indmoneyUs';sequence:number}|null{
 if((portfolio!=='zerodha'&&portfolio!=='indmoneyUs')||typeof sequence!=='string'||!/^[1-9][0-9]*$/.test(sequence))return null;
 const value=Number(sequence);return Number.isSafeInteger(value)?{portfolio,sequence:value}:null;
}
