/** UI geometry only. Nothing is persisted and no financial value is calculated. */
export function boundPanelPosition(position:{x:number;y:number},viewport:{width:number;height:number},panel:{width:number;height:number}){
 if(![viewport.width,viewport.height,panel.width,panel.height].every(n=>Number.isFinite(n)&&n>0))return{x:0,y:0};
 const left=(viewport.width-panel.width)/2;
 const minX=8-left,maxX=viewport.width-8-left-panel.width;
 const minY=-16,maxY=viewport.height-24-panel.height-8;
 const clamp=(n:number,min:number,max:number)=>min>max?0:Math.min(max,Math.max(min,Number.isFinite(n)?n:0));
 return{x:clamp(position.x,minX,maxX),y:clamp(position.y,minY,maxY)};
}
