'use strict';
// Deterministic council asset painter. No finish, varnish, cracks or rail shadow.
// Run from repository root: node layers/attire/council/paint.cjs
const fs = require('node:fs');
const {createImage,encodePNG}=require('../../../src/raster/index.cjs');
const W=2048,H=2560; let state=0x434f554e;
function rand(){state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296;}
const mix=(a,b,t)=>a.map((v,i)=>v*(1-t)+b[i]*t);
const C={red:[104,47,56],dark:[50,37,31],bone:[215,199,163],ochre:[180,138,71],gold:[201,164,90],green:[37,62,50]};
function path(start,segments){let pts=[start],last=start;for(const s of segments){if(s.length===2){pts.push(s);last=s;}else{const [x0,y0]=last;for(let j=1;j<=40;j++){let t=j/40,u=1-t;pts.push([u*u*u*x0+3*u*u*t*s[0]+3*u*t*t*s[2]+t*t*t*s[4],u*u*u*y0+3*u*u*t*s[1]+3*u*t*t*s[3]+t*t*t*s[5]]);}last=s.slice(4);}}return pts;}
function mask(poly){const a=new Uint8Array(W*H);let min=Math.max(144,Math.floor(Math.min(...poly.map(p=>p[1])))),max=Math.min(2367,Math.ceil(Math.max(...poly.map(p=>p[1]))));for(let y=min;y<=max;y++){let xs=[];for(let i=0,j=poly.length-1;i<poly.length;j=i++){let p=poly[i],q=poly[j];if((p[1]>y+.5)!==(q[1]>y+.5))xs.push(p[0]+(y+.5-p[1])*(q[0]-p[0])/(q[1]-p[1]));}xs.sort((a,b)=>a-b);for(let i=0;i<xs.length;i+=2)for(let x=Math.max(144,Math.ceil(xs[i]));x<Math.min(1904,xs[i+1]);x++)a[y*W+x]=255;}return a;}
function blend(im,x,y,c,alpha,clip){x=Math.round(x);y=Math.round(y);if(x<144||x>=1904||y<144||y>=2368)return;const k=y*W+x;if(clip&&!clip[k])return;let i=k*4, a=alpha/255,old=im.data[i+3]/255, n=a+old*(1-a);for(let j=0;j<3;j++)im.data[i+j]=Math.round((c[j]*a+im.data[i+j]*old*(1-a))/n);im.data[i+3]=Math.round(n*255);}
function dab(im,x,y,rx,ry,angle,c,opacity,clip){const co=Math.cos(angle),si=Math.sin(angle),r=Math.ceil(Math.max(rx,ry));for(let yy=Math.max(144,Math.floor(y-r));yy<=Math.min(2367,y+r);yy++)for(let xx=Math.max(144,Math.floor(x-r));xx<=Math.min(1903,x+r);xx++){let dx=xx-x,dy=yy-y,u=(dx*co+dy*si)/rx,v=(-dx*si+dy*co)/ry,d=u*u+v*v;if(d<1){let a=opacity*Math.min(1,(1-d)*4);blend(im,xx,yy,c,a,clip);}}}
function line(im,points,color,width,alpha,clip){for(let j=1;j<points.length;j++){let p=points[j-1],q=points[j],d=Math.hypot(q[0]-p[0],q[1]-p[1]);for(let t=0;t<=d;t+=Math.max(.8,width*.35)){let f=t/d;dab(im,p[0]+(q[0]-p[0])*f,p[1]+(q[1]-p[1])*f,width/2,width/2,0,color,alpha,clip);}}}
function base(im,m,shader){for(let y=144;y<2368;y++)for(let x=144;x<1904;x++){let k=y*W+x;if(!m[k])continue;let c=shader(x,y),i=k*4;for(let j=0;j<3;j++)im.data[i+j]=Math.max(1,Math.min(254,Math.round(c[j])));im.data[i+3]=255;}}
function velvet(x,y){let t=(x-144)/1760, drape=Math.sin((x-360-(y-1750)*.13)/75)+.38*Math.sin((x+(y-1750)*.32)/32);let l=.82-.34*t+.19*drape+.06*Math.sin(y/130);return C.red.map((v,i)=>v*l+(i===0?9:3));}
function cloth(im,m,shader,amount,angle){base(im,m,shader);for(let i=0;i<amount;i++){let x=144+rand()*1760,y=1550+rand()*818;if(!m[(y|0)*W+(x|0)])continue;let col=shader(x,y),d=(rand()-.5)*23;col=col.map(v=>v+d);dab(im,x,y,5+rand()*18,1+rand()*3,angle+rand()*.35,col,45+rand()*55,m);}}
const coat=createImage();
const body=path([365,1760],[[510,1695,660,1645,768,1600],[790,1682,1158,1682,1188,1600],[1310,1620,1475,1655,1575,1712],[1790,1715,1895,1870,1903,2030],[1904,2368],[144,2368],[144,2050],[144,1900,214,1782,365,1760]]);
const bm=mask(body);cloth(coat,bm,velvet,37000,1.3);
// Broad painted folds, lost shadow edges, and broken impasto on the upper-left ridges.
for(const [x,dx] of [[315,-95],[500,-50],[725,-15],[1100,75],[1360,90],[1640,120],[1795,50]]){
 const p=path([x,1780],[[x-45,1960,x+dx+15,2140,x+dx,2370]]);
 line(coat,p,[46,25,29],26,75,bm);line(coat,p.map(([a,b])=>[a-21,b]),[133,66,67],12,50,bm);
}
// Front overlap and cuff-like shoulder seams.
line(coat,path([1000,1815],[[1010,1990,1025,2170,1060,2368]]),[42,27,28],13,210,bm);
line(coat,path([990,1820],[[1000,2010,1014,2190,1048,2368]]),[151,88,77],4,130,bm);
for(const start of [[365,1788],[1575,1745]]) line(coat,path(start,[[start[0]+72,1900,start[0]+60,2130,start[0]+87,2367]]),[61,30,32],9,120,bm);
// Warm sable/ermine shawl, kept below the throat; two tapered lapels.
const furShapes=[path([365,1760],[[520,1680,672,1620,768,1585],[785,1645,880,1675,978,1664],[940,1735,951,1840,1000,1920],[840,1850,774,1750,690,1758],[580,1780,455,1804,365,1825]]),path([978,1664],[[1090,1650,1160,1632,1188,1585],[1290,1625,1450,1655,1575,1712],[1545,1762,1450,1804,1350,1810],[1190,1790,1100,1865,1000,1920],[1020,1815,1040,1735,978,1664]])];
const fm=mask(furShapes[0]),fm2=mask(furShapes[1]);for(let i=0;i<fm.length;i++)fm[i]=Math.max(fm[i],fm2[i]);
const furColor=(x,y)=>{let t=Math.min(.78,Math.max(.05,(x-400)/1550+(y-1660)/1700));let roll= .055*Math.sin((y-1615-(x-850)*.12)/15)+.035*Math.sin(x/39+y/28);return mix(C.bone,C.dark,Math.max(.05,t*.72+roll));};
base(coat,fm,furColor);
// Clumped underfur shadows and a broken contour, not a flat vector collar.
for(let i=0;i<1600;i++){let x=350+rand()*1230,y=1585+rand()*330;if(!fm[(y|0)*W+(x|0)])continue;let c=mix(furColor(x,y),C.dark,.12+rand()*.15);dab(coat,x,y,5+rand()*9,2+rand()*5,1.3,c,80,fm);}
for(let y=1585;y<1920;y+=3)for(let x=350;x<1580;x+=3){let k=y*W+x;if(fm[k]&&(!fm[k-3]||!fm[k+3]||!fm[k-3*W]||!fm[k+3*W])){let c=furColor(x,y),variation=(rand()-.5)*28;dab(coat,x+rand()*3-1.5,y+rand()*4-2,4+rand()*4,1.2,1.1+(x-980)*.0007,c.map(v=>v+variation),170);}}
// Individual tapered locks; short directional bristles keep the fur hand painted.
for(let i=0;i<34000;i++){let x=345+rand()*1250,y=1575+rand()*360;if(!fm[(y|0)*W+(x|0)])continue;const variation=(rand()-.5)*46; const c=furColor(x,y).map(v=>v+variation),angle=1.05+(x-980)*.0007;let len=7+rand()*17;dab(coat,x,y,len,1.1+rand()*1.7,angle,c,120,fm);if(i%4===0)dab(coat,x-2,y-3,len*.65,.7,angle,mix(c,C.bone,.4),155,fm);}
// Broken dark guard hairs, sparse and fine rather than uniform printed spots.
for(let i=0;i<160;i++){let x=420+rand()*1090,y=1645+rand()*200;if(!fm[(y|0)*W+(x|0)])continue;dab(coat,x,y,4+rand()*6,1.4,1.3,[72,57,43],120,fm);}
// Small covered buttons stop short of the free upper-chest chain landing.
for(const y of [2040,2160,2280]){dab(coat,1050+(y-2040)*.12,y,12,14,0,[43,27,28],255,bm);dab(coat,1047+(y-2040)*.12,y-3,8,9,0,[136,76,68],255,bm);dab(coat,1044+(y-2040)*.12,y-6,3,2,0,[180,126,94],160,bm);}
const sash=createImage();
const sashPoly=path([1510,1685],[[1540,1690,1570,1700,1600,1720],[1645,1770,1590,1820,1510,1865],[1280,2000,950,2170,610,2367],[396,2368],[770,2135,1120,1928,1450,1740],[1480,1720,1500,1700,1510,1685]]);
const sm=mask(sashPoly);
function sashColor(x,y){let cross=(x+1.65*y-4440)/210;let wave=Math.sin(cross*3.7)+.3*Math.sin((x-y)/39);let b=.92+.20*wave-.16*(x/2048);return mix(C.green,C.bone,.07).map(v=>v*b);}
cloth(sash,sm,sashColor,20000,2.58);
// Both woven gold selvedges follow the diagonal; no separate chain or shoulder clasp.
const edges=[path([1516,1695],[[1470,1770,1110,1945,405,2367]]),path([1590,1732],[[1605,1800,1170,2060,605,2367]])];
for(const p of edges){line(sash,p,[49,39,23],13,210,sm);line(sash,p,[155,123,68],7,220,sm);for(let j=1;j<p.length;j++){let a=p[j-1],b=p[j],d=Math.hypot(a[0]-b[0],a[1]-b[1]);for(let t=0;t<d;t+=10){let u=t/d;dab(sash,a[0]+(b[0]-a[0])*u-1,a[1]+(b[1]-a[1])*u-2,4,1.4,2.6,C.gold,180,sm);}}}
// Embroidered leaf sprays, deliberately sparse and broken in colour.
for(let t=.15;t<.93;t+=.1){let x=1535-1060*t,y=1760+637*t;for(let k=0;k<3;k++){let xx=x-14*k,yy=y+9*k;dab(sash,xx-9,yy-10,8,2.3,-2.3,[144,130,79],165,sm);dab(sash,xx+4,yy+8,7,2.1,.2,[112,114,67],150,sm);}}
// Gold council seal at the chest: scalloped sun, laurel and three deliberation rods.
const bx=1265,by=1915;
for(let j=0;j<24;j++){let a=j*Math.PI/12;dab(sash,bx+59*Math.cos(a),by+65*Math.sin(a),12,8,a,[97,72,38],255);}
dab(sash,bx+4,by+7,61,68,0,[42,35,24],255);
dab(sash,bx,by,61,68,0,C.ochre,255);dab(sash,bx-2,by-3,54,60,0,C.gold,255);dab(sash,bx+3,by+6,46,52,0,[108,80,40],255);dab(sash,bx,by,44,49,0,[162,126,64],255);
for(let i=0;i<8;i++){let a=Math.PI*.64+i*.22;for(const s of [-1,1]){let x=bx+s*33*Math.sin(a),y=by+34*Math.cos(a);dab(sash,x,y,7,3,s*a,[202,169,98],245);dab(sash,x-2,y-2,4,1.2,s*a,C.bone,150);}}
for(let i=-1;i<=1;i++){line(sash,[[bx+i*12,by+24],[bx+i*12,by-23+Math.abs(i)*8]],[81,59,29],6,255);line(sash,[[bx+i*12-2,by+20],[bx+i*12-2,by-25+Math.abs(i)*8]],C.gold,3,255);}
for(let i=0;i<22;i++){let a=3.4+rand()*2.2;dab(sash,bx+55*Math.cos(a),by+61*Math.sin(a),3+rand()*3,1.5,a+1.57,C.bone,160);}
// Clean hidden RGB and preserve straight RGBA8. No baked finishing pass.
for(const [name,im] of [['attire-front.council-coat',coat],['accessory.council-sash',sash]]){for(let i=0;i<im.data.length;i+=4)if(!im.data[i+3])im.data[i]=im.data[i+1]=im.data[i+2]=0;fs.writeFileSync(`layers/attire/council/${name}.png`,encodePNG(im));}
console.log('Painted two registered 2048×2560 straight RGBA8 council layers.');
