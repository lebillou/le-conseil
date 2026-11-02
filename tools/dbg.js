const E=require('../src/engine.js');
const sc=process.argv[2], seed=+process.argv[3]||1, cid=process.argv[4]||'D';
const G=E.newGame(sc,{seed});
const pl=G.companies.find(c=>c.player);
while(!G.over){E.simulateYear(G,E.defaultDecision(G,pl));
 const c=E.coById(G,cid); const h=E.lastH(c);
 console.log(h.t, c.alive?'':'DEAD', 'rev',h.rev.toFixed(0),'ebit',h.ebit.toFixed(0),'np',h.npRec.toFixed(0),'inv',h.inv.toFixed(0),'cash',h.cash.toFixed(0),'debt',h.debt.toFixed(0),'iss',h.issue.toFixed(0), Object.entries(c.div).map(([k,d])=>k+':'+(d.share*100).toFixed(0)+'%/'+(d.ebit/Math.max(1e-9,d.rev)*100).toFixed(0)+'%/r'+E.segById(G,k).r.toFixed(2)).join(' '));
}
