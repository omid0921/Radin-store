const $ = s => document.querySelector(s);
const money = value => new Intl.NumberFormat('fa-IR').format(Number(value || 0)) + ' تومان';
const state = { products: [], categories: [], cart: JSON.parse(localStorage.getItem('radin-cart') || '[]') };
const apiBase = (window.RADIN_CONFIG?.API_BASE_URL || '').replace(/\/$/, '');
function setMessage(text, show=true){ $('#message').textContent=text; $('#message').classList.toggle('hidden',!show); }
function updateCartBadge(){ $('#cartCount').textContent=moneyCount(state.cart.reduce((n,x)=>n+x.qty,0)); }
function moneyCount(n){return new Intl.NumberFormat('fa-IR').format(n)}
function saveCart(){localStorage.setItem('radin-cart',JSON.stringify(state.cart));updateCartBadge();renderCart();}
async function loadData(){
 if(!apiBase){$('#apiStatus').textContent='سرور هنوز تنظیم نشده';$('#apiStatus').className='status bad';setMessage('ویترین آماده است؛ برای نمایش محصولات واقعی، نشانی API در فایل config.js تنظیم و سرور فروشگاه منتشر شود.');return;}
 try{
  const [p,c]=await Promise.all([fetch(apiBase+'/public/products'),fetch(apiBase+'/public/categories')]);
  if(!p.ok||!c.ok) throw new Error('پاسخ سرور معتبر نیست');
  state.products=await p.json();state.categories=await c.json();
  $('#apiStatus').textContent='اتصال به فروشگاه برقرار است';$('#apiStatus').className='status ok';
  $('#categoryFilter').innerHTML='<option value="">همه دسته‌ها</option>'+state.categories.map(x=>`<option value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('');
  setMessage(state.products.length?'':'هنوز محصول فعالی در فروشگاه ثبت نشده است.',!state.products.length);renderProducts();
 }catch(e){$('#apiStatus').textContent='اتصال برقرار نشد';$('#apiStatus').className='status bad';setMessage('ارتباط با سرور برقرار نشد. نشانی API، فعال بودن سرور و تنظیم CORS را بررسی کنید.');}
}
function escapeHtml(s=''){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function renderProducts(){
 const q=$('#search').value.trim().toLocaleLowerCase('fa');const cat=$('#categoryFilter').value;
 const list=state.products.filter(p=>(!cat||p.category?.id===cat)&&(`${p.name} ${p.brand||''}`).toLocaleLowerCase('fa').includes(q));
 $('#products').innerHTML=list.map(p=>`<article class="product"><div class="muted">${escapeHtml(p.category?.name||'محصول')}</div><h3>${escapeHtml(p.name)}</h3>${p.brand?`<div class="brand-name">برند: ${escapeHtml(p.brand)}</div>`:''}${p.description?`<div class="muted">${escapeHtml(p.description)}</div>`:''}${p.variants.map(v=>`<div class="variant"><div><div>${escapeHtml(v.title)}</div><div class="price">${money(v.retailPrice)}</div><div class="stock">${v.stockQuantity>0?'موجود':'ناموجود'}</div></div><button class="add" data-add="${escapeHtml(v.id)}" ${v.stockQuantity<1?'disabled':''}>افزودن</button></div>`).join('')}</article>`).join('');
 if(!list.length)setMessage('محصولی با این جست‌وجو پیدا نشد.');else setMessage('',false);
}
function addToCart(id){const p=state.products.flatMap(x=>x.variants.map(v=>({...v,productName:x.name}))).find(v=>v.id===id);if(!p)return;const row=state.cart.find(x=>x.id===id);if(row)row.qty=Math.min(row.qty+1,p.stockQuantity);else state.cart.push({id:p.id,title:p.productName+' - '+p.title,price:Number(p.retailPrice),qty:1});saveCart();}
function renderCart(){const host=$('#cartItems');if(!state.cart.length){host.innerHTML='<p class="muted">سبد خرید خالی است.</p>';$('#cartTotal').textContent=money(0);return;}host.innerHTML=state.cart.map(x=>`<div class="cart-row"><div><strong>${escapeHtml(x.title)}</strong><div class="price">${money(x.price)}</div></div><div class="qty"><button data-dec="${x.id}">−</button><span>${moneyCount(x.qty)}</span><button data-inc="${x.id}">+</button></div></div>`).join('');$('#cartTotal').textContent=money(state.cart.reduce((n,x)=>n+x.price*x.qty,0));}
function openCart(open){$('#cartPanel').classList.toggle('hidden',!open);$('#overlay').classList.toggle('hidden',!open);}
document.addEventListener('click',e=>{const add=e.target.closest('[data-add]');if(add)addToCart(add.dataset.add);const inc=e.target.closest('[data-inc]');if(inc){const x=state.cart.find(i=>i.id===inc.dataset.inc);if(x)x.qty++;saveCart();}const dec=e.target.closest('[data-dec]');if(dec){const x=state.cart.find(i=>i.id===dec.dataset.dec);if(x)x.qty--;state.cart=state.cart.filter(i=>i.qty>0);saveCart();}});
$('#search').addEventListener('input',renderProducts);$('#categoryFilter').addEventListener('change',renderProducts);$('#cartOpen').onclick=()=>openCart(true);$('#cartClose').onclick=$('#overlay').onclick=()=>openCart(false);


$('#checkoutForm').addEventListener('submit', async e => {
 e.preventDefault();
 const message=$('#checkoutMessage');
 if(!state.cart.length){message.textContent='سبد خرید خالی است.';return;}
 if(!apiBase){message.textContent='ثبت سفارش هنوز فعال نیست؛ نشانی API فروشگاه تنظیم نشده است.';return;}
 const form=new FormData(e.currentTarget);
 const payload={
  customerName:String(form.get('customerName')||'').trim(),
  mobile:String(form.get('mobile')||'').trim(),
  city:String(form.get('city')||'').trim(),
  address:String(form.get('address')||'').trim(),
  postalCode:String(form.get('postalCode')||'').trim()||null,
  notes:String(form.get('notes')||'').trim()||null,
  items:state.cart.map(x=>({variantId:x.id,quantity:x.qty}))
 };
 const button=$('#submitOrder');button.disabled=true;button.textContent='در حال ثبت سفارش…';message.textContent='';
 try{
  const response=await fetch(apiBase+'/public/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(result.message||'ثبت سفارش انجام نشد.');
  state.cart=[];saveCart();e.currentTarget.reset();
  message.textContent=`${result.message||'سفارش ثبت شد.'} شماره سفارش: ${result.orderNumber}`;
  message.classList.add('success');
 }catch(error){message.textContent=error.message||'ارتباط با سرور برقرار نشد.';message.classList.remove('success');}
 finally{button.disabled=false;button.textContent='ثبت درخواست سفارش';}
});

let installPrompt;window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;$('#installBtn').classList.remove('hidden');});$('#installBtn').onclick=async()=>{if(!installPrompt)return;installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;$('#installBtn').classList.add('hidden');};
if('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(()=>{});
updateCartBadge();renderCart();loadData();
