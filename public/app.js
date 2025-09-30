
(function(){
  var ua = (navigator.userAgent || 'unknown');
  document.getElementById('ua').textContent = ua;
  var isNetCast = ua.indexOf('SRAF/') !== -1 || ua.indexOf('NetCast') !== -1 || ua.indexOf('Chrome/47') !== -1;
  var supportsWebCodecs = !isNetCast && ('VideoDecoder' in window) && ('EncodedVideoChunk' in window);

  function q(id){ return document.getElementById(id); }
  function el(t,c,txt){ var e=document.createElement(t); if(c) e.className=c; if(txt) e.textContent=txt; return e; }

  var gridSelect = q('gridSelect');
  gridSelect.onchange = function(){
    var m = q('camera-container');
    var val = gridSelect.value;
    m.className = 'grid ' + (val==='3' ? 'grid-3' : 'grid-2');
  };

  var presetSelect = q('presetSelect');
  presetSelect.onchange = function(){
    loadCams(function(_e, cams){
      for (var i=0;i<cams.length;i++){
        patchSettings(cams[i].id, {preset: presetSelect.value}, function(){ });
      }
      setTimeout(refreshStatus, 800);
    });
  };

  function xhr(method, url, body, cb){
    var x = new XMLHttpRequest();
    x.open(method, url, true);
    if (body) x.setRequestHeader('Content-Type','application/json');
    x.onreadystatechange=function(){ if (x.readyState===4){ cb(x.status, x.responseText); } };
    x.send(body ? JSON.stringify(body) : null);
  }
  function loadCams(cb){ xhr('GET','/config.json',null,function(s,r){ if(s===200){ try{ cb(null, JSON.parse(r).cameras||[]);}catch(e){cb(e,[]);} } else cb(new Error('fail'),[]); }); }
  function addCam(cam, cb){ xhr('POST','/api/cameras',cam,function(s){ cb(s>=200&&s<300?null:new Error('fail')); }); }
  function delCam(id, cb){ xhr('DELETE','/api/cameras/'+encodeURIComponent(id),null,function(s){ cb(s>=200&&s<300?null:new Error('fail')); }); }
  function patchSettings(id, body, cb){ xhr('PATCH','/api/cameras/'+encodeURIComponent(id)+'/settings',body,function(s){ cb(s>=200&&s<300?null:new Error('fail')); }); }
  function fetchLogs(id, cb){ xhr('GET','/api/logs/'+encodeURIComponent(id)+'?tail=200',null,function(s,r){ cb(s===200?null:new Error('fail'), r||''); }); }
  function fetchStatus(cb){ xhr('GET','/api/status',null,function(s,r){ if(s===200){ try{ cb(null, JSON.parse(r)); }catch(e){ cb(e,null);} } else cb(new Error('fail')); }); }

  function render(cams){
    var cont = q('camera-container'); cont.innerHTML='';
    for (var i=0;i<cams.length;i++){
      (function(cam){
        var card = el('div','card');
        var h = el('h3',null, cam.name || cam.id);
        var badge = el('span','badge', supportsWebCodecs ? 'WebSocket H.264' : 'legacy mp4');
        h.appendChild(badge);
        card.appendChild(h);

        var wrap = el('div','video-wrap');
        if (supportsWebCodecs){
          var canvas = document.createElement('canvas');
          canvas.width = 1280; canvas.height = 720;
          wrap.appendChild(canvas);
          startWsPlay(cam.id, canvas);
        } else {
          var v = document.createElement('video');
          v.setAttribute('autoplay','autoplay');
          v.setAttribute('muted','muted');
          v.setAttribute('playsinline','playsinline');
          v.setAttribute('controls','controls');
          v.src = (cam.legacy || ('/streams/'+cam.id+'/legacy.mp4')) + '?t=' + Date.now();
          wrap.appendChild(v);
        }
        card.appendChild(wrap);

        var actions = el('div','actions');
        var btnLogs = el('button','btn','Logs');
        var btnDelete = el('button','btn','Delete');
        var btnPreset = el('button','btn','Preset: '+(cam.preset||'balanced'));
        btnLogs.onclick = function(){ fetchLogs(cam.id, function(_e,text){ showModal('Logs: '+cam.id, text||'(empty)'); }); };
        btnDelete.onclick = function(){ if(confirm('Delete '+cam.id+'?')) delCam(cam.id, function(e){ if(e) alert('Delete failed'); else init(); }); };
        btnPreset.onclick = function(){
          var order=['low','balanced','high'];
          var cur = cam.preset||'balanced';
          var idx = (order.indexOf(cur)+1)%order.length;
          var next = order[idx];
          patchSettings(cam.id,{preset:next}, function(e){ if(e) alert('Save failed'); else setTimeout(init, 600); });
        };
        actions.appendChild(btnPreset);
        actions.appendChild(btnLogs);
        actions.appendChild(btnDelete);
        card.appendChild(actions);

        var status = el('div','status','…');
        status.id = 'status-'+cam.id;
        card.appendChild(status);

        cont.appendChild(card);
      })(cams[i]);
    }
    refreshStatus();
  }

  function refreshStatus(){
    fetchStatus(function(_e, data){
      if (!data || !data.cameras) return;
      for (var i=0;i<data.cameras.length;i++){
        var s = data.cameras[i];
        var elx = q('status-'+s.id);
        if (!elx) continue;
        var t = 'preset='+s.preset+' | legacy='+(s.legacyRunning?'on':'off')+' ('+Math.round(s.legacySize/1024)+' KB) | ws='+(s.wsRunning?'on':'off')+' clients='+s.wsClients;
        elx.textContent = t;
      }
    });
  }
  setInterval(refreshStatus, 2000);

  function startWsPlay(id, canvas){
    var url = (location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws/'+encodeURIComponent(id);
    var ws = new WebSocket(url);
    var ctx = canvas.getContext('2d');
    var decoder;
    try{
      decoder = new VideoDecoder({
        output: function(frame){
          try{ ctx.drawImage(frame, 0, 0, canvas.width, canvas.height); }
          finally{ frame.close(); }
        },
        error: function(e){ console.log(e); }
      });
      decoder.configure({ codec: 'avc1.42E01E' });
    }catch(e){ console.log('WebCodecs init fail', e); }
    ws.binaryType = 'arraybuffer';
    ws.onmessage = function(ev){
      if (!decoder) return;
      var chunk = new EncodedVideoChunk({
        type: 'key',
        timestamp: performance.now()*1000,
        data: new Uint8Array(ev.data)
      });
      try{ decoder.decode(chunk); }catch(_){}
    };
    ws.onclose = function(){ try{ decoder && decoder.close(); }catch(_){ } };
  }

  var modal = q('modal'), modalTitle=q('modalTitle'), modalBody=q('modalBody');
  q('modalClose').onclick=function(){ modal.classList.add('hidden'); };
  function showModal(title, body){ modalTitle.textContent=title; modalBody.textContent=body; modal.classList.remove('hidden'); }

  function init(){
    loadCams(function(_e,cams){ render(cams); });
  }
  init();

  q('btnAdd').onclick=function(){
    var name = q('camName').value || '';
    var rtsp = q('camRtsp').value || '';
    if(!rtsp){ alert('RTSP required'); return; }
    var id = name || ('cam'+Date.now());
    addCam({id:id,name:name,rtsp:rtsp}, function(e){ if(e) alert('Add failed'); else init(); });
  };

  q('btnChangelog').onclick=function(){
    xhr('GET','/CHANGELOG.md',null,function(s,r){ showModal('Changelog', s===200?r:'(no changelog)'); });
  };
})();
