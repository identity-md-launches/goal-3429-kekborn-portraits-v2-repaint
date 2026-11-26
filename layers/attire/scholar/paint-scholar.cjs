'use strict';
// Reproducible master-size paint study. No finishing effects are baked in.
// Run from the repository root: node layers/attire/scholar/paint-scholar.cjs
const fs = require('node:fs');
const path = require('node:path');
const {createImage, encodePNG} = require('../../../src/raster/index.cjs');
const W=2048,H=2560;
let state=0x5c401a2;
function random(){state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;}
const rgb = h => h.match(/[a-f0-9]{2}/gi).map(v=>parseInt(v,16));
const mix=(a,b,t)=>a.map((v,i)=>v*(1-t)+b[i]*t);
function curve(a,b,c,d,n=100){return Array.from({length:n+1},(_,i)=>{const t=i/n,s=1-t;return [s*s*s*a[0]+3*s*s*t*b[0]+3*s*t*t*c[0]+t*t*t*d[0],s*s*s*a[1]+3*s*s*t*b[1]+3*s*t*t*c[1]+t*t*t*d[1]];});}
function outline(start,segments){let p=[start],last=start;for(const seg of segments){if(seg.length===2)p.push(seg);else p.push(...curve(last,seg.slice(0,2),seg.slice(2,4),seg.slice(4,6),80).slice(1));last=p[p.length-1];}return p;}
function mask(points){const m=new Uint8Array(W*H);for(let y=144;y<2368;y++){const xx=[];for(let i=0,j=points.length-1;i<points.length;j=i++){const a=points[j],b=points[i];if((a[1]>y+.5)!==(b[1]>y+.5))xx.push(a[0]+(y+.5-a[1])*(b[0]-a[0])/(b[1]-a[1]));}xx.sort((a,b)=>a-b);for(let k=0;k<xx.length;k+=2)for(let x=Math.max(144,Math.floor(xx[k]));x<Math.min(1904,Math.ceil(xx[k+1]));x++)m[y*W+x]=Math.round(255*Math.max(0,Math.min(x+1,xx[k+1])-Math.max(x,xx[k])));}return m;}
function dab(im,x,y,r,color,alpha=1,clip){for(let yy=Math.max(144,Math.floor(y-r));yy<=Math.min(2367,Math.ceil(y+r));yy++)for(let xx=Math.max(144,Math.floor(x-r));xx<=Math.min(1903,Math.ceil(x+r));xx++){const q=yy*W+xx,edge=Math.max(0,Math.min(1,r+.5-Math.hypot(xx-x,yy-y)));let a=edge*alpha*(clip?clip[q]/255:1);if(!a)continue;const i=q*4,old=im.data[i+3]/255,out=a+old*(1-a);for(let c=0;c<3;c++)im.data[i+c]=Math.round((color[c]*a+im.data[i+c]*old*(1-a))/out);im.data[i+3]=Math.round(out*255);}}
function line(im,pts,color,width,alpha=1,clip){for(let i=1;i<pts.length;i++){const a=pts[i-1],b=pts[i],n=Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])*1.3));for(let j=0;j<=n;j++){let t=j/n;dab(im,a[0]*(1-t)+b[0]*t,a[1]*(1-t)+b[1]*t,width/2,color,alpha,clip);}}}
function cloth(im,points,base,light,folds,seedDensity=26000){const m=mask(points),lo=rgb(base),hi=rgb(light);for(let y=1400;y<2368;y++)for(let x=144;x<1904;x++){let q=y*W+x;if(!m[q])continue;let v=.33+.21*(1-(x-144)/1760)+.12*(1-(y-1400)/968);for(const f of folds){const axis=f[0]+(y-1650)*f[1],d=(x-axis)/f[2];v+=f[3]*Math.exp(-d*d)-.17*Math.exp(-Math.pow(d-.95,2)*2);}v+=.045*Math.sin(x*.047+y*.019)+.022*Math.sin(x*.121-y*.062);v=Math.max(.04,Math.min(.95,v));const col=mix(lo,hi,v),i=q*4,a=m[q]/255,under=im.data[i+3]/255*(1-a),out=a+under;for(let c=0;c<3;c++)im.data[i+c]=(col[c]*a+im.data[i+c]*under)/out;im.data[i+3]=Math.round(out*255);}
  // Broken opaque bristle marks follow the hanging drapery. Low contrast,
  // variable length, with short dry-brush filaments rather than a crack net.
  for(let j=0;j<seedDensity;j++){const x=144+random()*1760,y=1400+random()*968,q=Math.floor(y)*W+Math.floor(x);if(m[q]<240)continue;const i=q*4,sg=random()<.52?1:-1,v=3+random()*9,col=[0,1,2].map(c=>Math.max(12,Math.min(230,im.data[i+c]+sg*v)));const len=5+random()*30,dx=2+random()*7;line(im,[[x,y],[x+dx*.4,y+len*.5],[x+dx,y+len]],col,1+random()*3,.48,m);}
  return m;
}
function save(name,im){for(let i=0;i<im.data.length;i+=4)if(im.data[i+3]===0)im.data.fill(0,i,i+4);fs.writeFileSync(path.join(__dirname,name+'.png'),encodePNG(im));}
const hood=createImage();
const hoodPts=outline([346,1768],[[316,1690,390,1564,508,1514],[660,1478,785,1456,980,1450],[1220,1436,1468,1404,1538,1498],[1618,1580,1670,1680,1726,1788],[1500,1902,1300,1850,1060,1860],[812,1872,464,1882,346,1768]]);
const hm=cloth(hood,hoodPts,'17281f','657044',[[540,.3,80,.24],[1390,-.22,100,.3],[1230,.5,50,.14]],17000);
line(hood,curve([465,1716],[550,1490],[1270,1460],[1498,1650]),rgb('657044'),19,.35,hm);
line(hood,curve([1434,1530],[1300,1575],[1410,1700],[1590,1745]),rgb('141d17'),30,.62,hm);
line(hood,curve([1440,1545],[1308,1590],[1420,1708],[1600,1758]),rgb('657044'),11,.36,hm);
line(hood,curve([1470,1463],[1590,1515],[1558,1638],[1685,1750]),rgb('101e17'),32,.55,hm);
line(hood,curve([1482,1462],[1603,1518],[1576,1640],[1699,1747]),rgb('4a5940'),15,.20,hm);
line(hood,curve([492,1538],[425,1600],[390,1670],[380,1727]),rgb('4a5940'),24,.20,hm);
line(hood,curve([500,1550],[450,1600],[420,1670],[412,1727]),rgb('17281f'),18,.65,hm);
save('attire-back.scholar-folded-hood',hood);
const robe=createImage();
// Generous outer contour covers the foundation's shoulder mass completely.
const body=outline([770,1574],[[666,1602,492,1655,365,1738],[234,1775,162,1895,150,2050],[146,2190,162,2300,176,2368],[1872,2368],[1892,2220,1900,2110,1852,1950],[1840,1810,1735,1720,1575,1688],[1454,1650,1294,1584,1188,1566],[1090,1650,885,1660,770,1574]]);
const bodyCoverage=body.map(([x,y])=>[x+(x<978?-4:6)*Math.max(0,Math.min(1,(y-1700)/100)),y]);
const bm=cloth(robe,bodyCoverage,'322025','86434a',[[375,.08,90,.17],[610,.18,70,.22],[770,.28,48,.25],[1110,.12,120,-.14],[1430,.22,95,.19],[1690,.14,72,.08]],43000);
// Dark academic facings flank the breast opening, without a central badge
// that would conflict with a future scroll, hand, chain or coat of arms.
const facing=outline([747,1596],[[722,1690,759,1810,861,1908],[916,2010,948,2170,945,2368],[1092,2368],[1084,2160,1040,1980,1000,1860],[1164,1770,1277,1688,1217,1588],[1090,1680,874,1682,747,1596]]);
const fm=cloth(robe,facing,'2c2023','682f38',[[915,.16,42,.25],[1110,-.08,40,.12]],8500);
line(robe,curve([760,1620],[734,1775],[905,1830],[958,2080]),rgb('b48a47'),5,.40,fm);
line(robe,curve([1210,1620],[1174,1742],[1044,1810],[1005,1882]),rgb('b48a47'),4,.36,fm);
// Standing linen collar: top lip registers to the neck ellipse, a split at
// front keeps the throat visible above y=1536 and gives the garment depth.
const collar=outline([768,1544],[[858,1580,1066,1597,1189,1538],[1200,1585,1220,1620,1246,1650],[1174,1700,1083,1730,1004,1744],[966,1705],[929,1745],[850,1736,774,1689,745,1630],[753,1590,760,1560,768,1544]]);
const cm=cloth(robe,collar,'756952','d7c7a3',[[795,.1,45,.22],[1000,.1,32,.15],[1180,.1,48,-.12]],9000);
line(robe,curve([772,1548],[890,1598],[1085,1600],[1186,1544]),rgb('e0d2b6'),7,.75,cm);
line(robe,curve([778,1572],[892,1621],[1080,1620],[1193,1569]),rgb('998c70'),3,.5,cm);
for(let k=0;k<28;k++){const x=780+k*15,y=1610+30*Math.sin(k/27*Math.PI);line(robe,[[x,y],[x+6,y+34+random()*17]],rgb('a4977c'),1.5,.35,cm);}
line(robe,[[929,1743],[967,1705],[1004,1744]],rgb('564735'),5,.6,cm);
save('attire-front.scholar-robe',robe);
const specs=createImage();
const dark=rgb('493827'),gold=rgb('b48a47'),lit=rgb('d7c7a3');
// Far lens 120 x 110, near lens 180 x 160, exactly registered.
for(const [cx,cy,rx,ry] of [[680,936,60,55],[1040,912,90,80]]){
  for(let y=cy-ry+4;y<cy+ry-4;y++)for(let x=cx-rx+4;x<cx+rx-4;x++)if(((x-cx)/(rx-5))**2+((y-cy)/(ry-5))**2<1){const i=(y*W+x)*4;specs.data.set([193,190,157,5],i);}
  const ellipse=(dx=0,dy=0)=>Array.from({length:241},(_,i)=>{let t=i/240*Math.PI*2;return[cx+dx+Math.cos(t)*rx,cy+dy+Math.sin(t)*ry];});
  line(specs,ellipse(1.5,2),dark,9);
  line(specs,ellipse(),gold,5);
  const arc=Array.from({length:90},(_,i)=>{let t=Math.PI*1.02+i/89*Math.PI*.77;return[cx+Math.cos(t)*(rx-.7),cy+Math.sin(t)*(ry-.7)];});
  line(specs,arc,lit,2.2,.85);
  line(specs,curve([cx-rx*.62,cy-ry*.28],[cx-rx*.42,cy-ry*.7],[cx-rx*.20,cy-ry*.8],[cx+rx*.10,cy-ry*.80]),lit,2,.19);
}
for(const pts of [curve([739,931],[801,864],[883,856],[951,904]),curve([1129,904],[1190,875],[1254,909],[1276,970]),curve([621,929],[597,919],[589,902],[584,889])]){
 line(specs,pts,dark,8);line(specs,pts,gold,4);line(specs,pts.map(([x,y])=>[x,y-1.7]),lit,1.2,.68);
}
for(const [x,y] of [[740,929],[951,904],[1129,904],[621,929]]){dab(specs,x,y,5,dark);dab(specs,x-1,y-1,2.8,gold);dab(specs,x-2,y-2,1,lit);}
save('accessory.scholar-spectacles',specs);
