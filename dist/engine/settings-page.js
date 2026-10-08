const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Account settings \xB7 Armadillo</title><style>
body{margin:0;background:#f4f1ea;color:#1c1915;font:16px/1.5 system-ui,sans-serif}main{max-width:36rem;margin:0 auto;padding:3rem 1.25rem}
h1{font-size:1.9rem}section{background:white;border:1px solid #e6e1d8;border-radius:16px;padding:1.3rem;margin:1rem 0}
label{display:block;margin:.8rem 0}input{width:100%;box-sizing:border-box;padding:.7rem;border:1px solid #cfc8bd;border-radius:9px;font:inherit}
button{padding:.7rem 1rem;background:#1c1915;color:white;border:0;border-radius:99px;font:inherit;cursor:pointer}
.muted{color:#6b645c}#message{min-height:1.5em}
</style><main><p class="muted">Armadillo / account</p><h1>Your settings</h1>
<section><h2>Profile</h2><p id="email">Loading\u2026</p><form id="profile"><label>Display name<input id="name" maxlength="120" required></label><button>Save name</button></form></section>
<section><h2>Password</h2><form id="password"><label>Current password<input id="current" type="password" autocomplete="current-password" required></label>
<label>New password<input id="next" type="password" autocomplete="new-password" minlength="10" required></label><button>Change password</button></form></section>
<!--PHOTO_SECTION--><p id="message" role="status"></p></main><script>
(function(){var message=document.getElementById('message');
function api(path,method,body){return fetch(path,{method:method||'GET',credentials:'same-origin',headers:{'x-armadillo-auth-mode':'cookie',...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}).then(async function(response){var data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error?.message||'Request failed');return data;});}
api('/v1/auth/me').then(function(result){document.getElementById('email').textContent=result.user.email;document.getElementById('name').value=result.user.name||'';
var photo=document.getElementById('photo-preview');if(photo&&result.user.profilePhotoId){photo.src='/v1/auth/profile-photo?at='+Date.now();photo.hidden=false;}
}).catch(function(error){message.textContent=error.message;});
document.getElementById('profile').addEventListener('submit',function(event){event.preventDefault();api('/v1/auth/me','PATCH',{name:document.getElementById('name').value}).then(function(){message.textContent='Name saved.';}).catch(function(error){message.textContent=error.message;});});
document.getElementById('password').addEventListener('submit',function(event){event.preventDefault();api('/v1/auth/password','POST',{currentPassword:document.getElementById('current').value,newPassword:document.getElementById('next').value}).then(function(){message.textContent='Password changed. Sign in again.';document.getElementById('password').reset();}).catch(function(error){message.textContent=error.message;});});
var photoForm=document.getElementById('photo-form');if(photoForm){photoForm.addEventListener('submit',async function(event){event.preventDefault();var file=document.getElementById('photo-file').files[0];
if(!file)return;if(!['image/jpeg','image/png','image/webp','image/avif'].includes(file.type)||file.size>5000000){message.textContent='Choose a JPEG, PNG, WebP, or AVIF under 5 MB.';return;}
try{var response=await fetch('/v1/files',{method:'POST',credentials:'same-origin',headers:{'x-armadillo-auth-mode':'cookie','x-armadillo-file-name':encodeURIComponent(file.name),'content-type':file.type},body:file});
var uploaded=await response.json();if(!response.ok)throw new Error(uploaded.error?.message||'Upload failed');await api('/v1/auth/profile-photo','PUT',{fileId:uploaded.file.id});
var photo=document.getElementById('photo-preview');photo.src='/v1/auth/profile-photo?at='+Date.now();photo.hidden=false;message.textContent='Photo saved.';
}catch(error){message.textContent=error.message;}});
document.getElementById('photo-remove').addEventListener('click',function(){fetch('/v1/auth/profile-photo',{method:'DELETE',credentials:'same-origin',headers:{'x-armadillo-auth-mode':'cookie'}}).then(function(response){if(!response.ok)throw new Error('Could not remove photo');document.getElementById('photo-preview').hidden=true;message.textContent='Photo removed.';}).catch(function(error){message.textContent=error.message;});});}
})();</script></html>`;
const PHOTO_SECTION = `<section><h2>Profile photo</h2><img id="photo-preview" alt="Your profile photo" width="96" height="96" hidden style="object-fit:cover;border-radius:50%">
<form id="photo-form"><label>Upload an image<input id="photo-file" type="file" accept="image/jpeg,image/png,image/webp,image/avif" required></label><button>Save photo</button></form>
<p><button type="button" id="photo-remove">Remove photo</button></p></section>`;
function settingsPage(method, profilePhoto = false) {
  return new Response(method === "HEAD" ? null : PAGE.replace("<!--PHOTO_SECTION-->", profilePhoto ? PHOTO_SECTION : ""), { headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `default-src 'self'; script-src 'sha256-HM0/8rN3vgj12VDTRdE9q2PbFiuUsj/p3m1CzzP6OEY='; style-src 'unsafe-inline'; connect-src 'self'; img-src ${profilePhoto ? "'self'" : "'none'"}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    "x-content-type-options": "nosniff"
  } });
}
export {
  settingsPage
};
