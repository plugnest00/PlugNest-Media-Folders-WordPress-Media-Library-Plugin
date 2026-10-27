/**
 * PlugNest Media Folders — 後台互動邏輯。
 *
 * 全部使用原生 JavaScript，不依賴 jQuery。
 * 所有寫入都經過 AJAX，並在畫面上即時反映結果。
 *
 * @package PlugNest Media Folders
 */

( function () {
	'use strict';

	if ( typeof window.PNMF === 'undefined' ) {
		return;
	}

	const CFG = window.PNMF;

	/* wp_localize_script 會把所有純量轉成字串（PHP 端 int 0 到這裡變 '0'，
	 * 而 '0' 在 JS 是 truthy）——不正規化的話，免費版的 Pro 鎖定樣式、
	 * upsell 彈窗攔截與 Pro UI 綁定全部會失準。 */
	CFG.pro = ( '1' === CFG.pro || 1 === CFG.pro || true === CFG.pro );
	/* 同一個坑：'0' 是 truthy，導覽旗標也要正規化，否則關不掉。 */
	CFG.guide = ( '1' === CFG.guide || 1 === CFG.guide || true === CFG.guide );

	/* wp.i18n（PHP 端已把 wp-i18n 註冊為依賴）；帶後備避免載入順序問題。 */
	const i18n = window.wp && window.wp.i18n ? window.wp.i18n : {};
	const __ = function ( text, domain ) {
		if ( CFG.i18n && Object.prototype.hasOwnProperty.call( CFG.i18n, text ) ) {
			return CFG.i18n[ text ];
		}
		return i18n.__ ? i18n.__( text, domain || 'plugnest-media-folders' ) : text;
	};
	const sprintf = i18n.sprintf || function ( s ) { return s; };

	/* =========================================================
	 *  狀態
	 * ========================================================= */

	const state = {
		folderId: 0,
		tagIds: [],
		mimeGroup: '',
		usage: '',
		search: '',
		sort: 'date-DESC',
		includeChildren: true,
		/* 檢視模式：grid（縮略圖）/ list（列表）。記在 localStorage。 */
		view: localStorage.getItem( 'pnmf-view' ) === 'list' ? 'list' : 'grid',
		paged: 1,
		perPage: CFG.perPage || 60,
		total: 0,
		pages: 1,
		items: [],
		selected: new Set(),
		selectAll: false,
		dragIds: null,
		/* 檔案拖到特定資料夾列上放開時的「一次性」上傳目標（term_id，0=無）。 */
		uploadFolderOverride: 0,
		current: null,
		currentTags: [],
		collapsed: new Set(),
		folders: CFG.folders || [],
		tags: CFG.tags || [],
		views: Array.isArray( CFG.views ) ? CFG.views : [],
		stats: CFG.stats || {},
		rules: CFG.rules || [],
		folderPaths: CFG.folderPaths || [],
		dirty: false,
	};

	/* =========================================================
	 *  小工具
	 * ========================================================= */

	const $ = ( sel, root ) => ( root || document ).querySelector( sel );

	function esc( str ) {
		return String( str === null || str === undefined ? '' : str )
			.replace( /&/g, '&amp;' )
			.replace( /</g, '&lt;' )
			.replace( />/g, '&gt;' )
			.replace( /"/g, '&quot;' )
			.replace( /'/g, '&#039;' );
	}

	/**
	 * 資料夾顏色小工具：服務端存「不含 # 的 hex」，CSS 需要帶 #。
	 * colHex('#a23') → '#aa2233'（3 位展開）；不合法回空字串。
	 */
	function colHex( c ) {
		if ( ! c ) {
			return '';
		}
		let h = String( c ).replace( '#', '' ).toLowerCase();
		if ( 3 === h.length ) {
			h = h.split( '' ).map( ( x ) => x + x ).join( '' );
		}
		return /^[0-9a-f]{6}$/.test( h ) ? '#' + h : '';
	}

	/** colVars('#a23') → '--pnmf-c:#aa2233;--pnmf-c-soft:rgba(…,.16);--pnmf-c-hover:rgba(…,.3)' */
	function colVars( c ) {
		const hex = colHex( c );
		if ( ! hex ) {
			return '';
		}
		const r = parseInt( hex.slice( 1, 3 ), 16 );
		const g = parseInt( hex.slice( 3, 5 ), 16 );
		const b = parseInt( hex.slice( 5, 7 ), 16 );
		return (
			'--pnmf-c:' + hex +
			';--pnmf-c-soft:rgba(' + r + ',' + g + ',' + b + ',.16)' +
			';--pnmf-c-hover:rgba(' + r + ',' + g + ',' + b + ',.3)'
		);
	}

	let toastTimer = null;

	/** 使用者是否按下了「中止」，用來讓自動分類的迴圈停下來。 */
	let autoCancelled = false;

	function toast( message, type ) {
		const el = $( '#pnmf-toast' );
		if ( ! el ) {
			return;
		}
		el.textContent = message;
		el.className = 'pnmf-toast' + ( type ? ' is-' + type : '' );
		el.hidden = false;
		clearTimeout( toastTimer );
		toastTimer = setTimeout( () => {
			el.hidden = true;
		}, 3200 );
	}

	function progress( show, text, percent, cancellable ) {
		const wrap = $( '#pnmf-progress' );
		const label = $( '#pnmf-progress-text' );
		const fill = $( '#pnmf-progress-fill' );
		const cancel = $( '#pnmf-progress-cancel' );

		if ( ! wrap ) {
			return;
		}

		wrap.hidden = ! show;
		if ( show ) {
			label.textContent = text || __( 'Processing…', 'plugnest-media-folders' );
			fill.style.width = ( percent || 0 ) + '%';
			cancel.hidden = ! cancellable;
		}
	}

	/**
	 * 呼叫 AJAX 端點。
	 *
	 * @param {string} action 不含前綴的動作名稱。
	 * @param {Object} data   參數。
	 * @return {Promise<Object>}
	 */
	async function api( action, data ) {
		const body = new FormData();
		body.append( 'action', 'pnmf_' + action );
		body.append( 'nonce', CFG.nonce );

		Object.keys( data || {} ).forEach( ( key ) => {
			const value = data[ key ];
			if ( Array.isArray( value ) ) {
				value.forEach( ( v ) => body.append( key + '[]', v ) );
			} else if ( value !== undefined && value !== null ) {
				body.append( key, value );
			}
		} );

		const response = await fetch( CFG.ajaxUrl, {
			method: 'POST',
			body,
			credentials: 'same-origin',
		} );

		let json;
		try {
			json = await response.json();
		} catch ( e ) {
			throw new Error( __( 'Invalid server response. Please reload the page.', 'plugnest-media-folders' ) );
		}

		if ( ! json || ! json.success ) {
			const msg = json && json.data && json.data.message ? json.data.message : __( 'Operation failed.', 'plugnest-media-folders' );
			throw new Error( msg );
		}

		return json.data;
	}

	function debounce( fn, wait ) {
		let timer = null;
		return function () {
			const args = arguments;
			clearTimeout( timer );
			timer = setTimeout( () => fn.apply( this, args ), wait );
		};
	}

	/* =========================================================
	 *  統計
	 * ========================================================= */

	function renderStats( stats ) {
		state.stats = stats;

		const items = [
			{ value: stats.total, label: __( 'Total media', 'plugnest-media-folders' ) },
			{ value: stats.folders, label: __( 'Folders', 'plugnest-media-folders' ) },
			{ value: stats.unassigned, label: __( 'Unassigned', 'plugnest-media-folders' ), cls: 'pnmf-stat--warn' },
			{ value: stats.used, label: __( 'In use', 'plugnest-media-folders' ) },
			{ value: stats.unused, label: __( 'Unused', 'plugnest-media-folders' ), cls: 'pnmf-stat--alert' },
			{ value: stats.unscanned, label: __( 'Not scanned', 'plugnest-media-folders' ) },
		];

		$( '#pnmf-stats' ).innerHTML = items
			.map(
				( it ) =>
					'<div class="pnmf-stat ' +
					( it.cls || '' ) +
					'"><div class="pnmf-stat-value">' +
					esc( it.value ) +
					'</div><div class="pnmf-stat-label">' +
					esc( it.label ) +
					'</div></div>'
			)
			.join( '' );
	}

	/* =========================================================
	 *  資料夾樹
	 * ========================================================= */

	function renderTree() {
		const tree = $( '#pnmf-tree' );
		const rows = [];

		rows.push(
			item( {
				key: 'all',
				name: __( 'All media', 'plugnest-media-folders' ),
				count: state.stats.total,
				depth: 0,
				active: state.folderId === 0,
			} )
		);
		rows.push(
			item( {
				key: 'none',
				name: __( 'Unassigned', 'plugnest-media-folders' ),
				count: state.stats.unassigned,
				depth: 0,
				active: state.folderId === 'none',
				warn: true,
			} )
		);

		/* 釘選（星標）資料夾：平鋪在樹頂，點擊直接跳轉；★ 可點擊取消釘選。 */
		const pinned = state.folders.filter( ( f ) => f.star );
		if ( pinned.length ) {
			rows.push( '<li class="pnmf-tree-pinned-label">' + __( 'Pinned', 'plugnest-media-folders' ) + '</li>' );
			pinned.forEach( ( f ) => {
				rows.push(
					item( {
						key: 'star-' + f.term_id,
						name: f.name,
						count: f.count,
						depth: 0,
						active: state.folderId === f.term_id,
						termId: f.term_id,
						color: f.color,
						star: 1,
						pinned: true,
					} )
				);
			} );
		}

		/*
		 * 這裡一定要用 visibleFolders()，不能用 state.folders。
		 * 用後者的話收合狀態只會改變箭頭，子層還是照樣全部渲染出來
		 * ——看起來就是「怎麼點都收不起來」。
		 */
		visibleFolders().forEach( ( f ) => {
			rows.push(
				item( {
					key: f.term_id,
					name: f.name,
					count: f.count,
					depth: f.depth,
					active: state.folderId === f.term_id,
					termId: f.term_id,
					color: f.color,
					star: f.star,
					hasChildren: state.folders.some( ( c ) => c.parent === f.term_id ),
				} )
			);
		} );

		tree.innerHTML = rows.join( '' );

		function item( o ) {
			const pad = 10 + ( o.depth || 0 ) * 14;
			const collapsed = state.collapsed.has( o.termId );
			const toggle = o.hasChildren
				? '<span class="pnmf-tree-toggle" data-toggle="' +
				  o.termId +
				  '">' +
				  ( collapsed ? '▶' : '▼' ) +
				  '</span>'
				: '<span class="pnmf-tree-toggle"></span>';

			const colorDot = o.color
				? '<span class="pnmf-tree-dot" style="background:' + esc( colHex( o.color ) ) + '"></span>'
				: '';
			/* 有設定角色的資料夾：名稱後挂鎖徽章（告知受限中）。 */
			const lockBadge = ( o.roles && o.roles.length )
				? ' <span class="pnmf-tree-lock" title="' + esc( __( 'Folder access roles', 'plugnest-media-folders' ) ) + '">🔒</span>'
				: '';

			/* 釘選列的 ★ 是可點擊的取消鈕（其餘區域點擊＝跳轉）。 */
			if ( o.pinned ) {
				return (
					'<li class="pnmf-tree-item' +
					( o.active ? ' is-active' : '' ) +
					( o.color ? ' is-colored' : '' ) +
					' is-pinned" style="padding-left:' +
					pad +
					'px' +
					( o.color ? ';' + colVars( o.color ) : '' ) +
					'" data-key="' +
					o.key +
					'"' +
					( o.termId !== undefined ? ' data-term="' + o.termId + '"' : '' ) +
					'>' +
					'<button type="button" class="pnmf-tree-star is-starred" data-star="' +
					o.termId +
					'" data-starred="1" title="' + __( 'Unpin folder', 'plugnest-media-folders' ) + '">★</button>' +
					colorDot +
					'<span class="pnmf-tree-name">' +
					esc( o.name ) +
					'</span>' +
					'<span class="pnmf-tree-count">' +
					esc( o.count || 0 ) +
					'</span>' +
					'</li>'
				);
			}

			/* 🔒 存取角色鈕：免費版也顯示，但帶鎖定樣式（點擊→購買引導）。 */
			const rolesBtn =
				'<button type="button" data-roles="' +
				o.termId +
				'" title="' + __( 'Folder access roles', 'plugnest-media-folders' ) + '" class="' +
				( CFG.pro ? '' : 'pnmf-pro-locked' ) +
				'">🔒</button>';
			const starBtn =
				'<button type="button" data-star="' +
				o.termId +
				'" data-starred="' +
				( o.star ? '1' : '0' ) +
				'" title="' + __( 'Pin folder', 'plugnest-media-folders' ) + '" class="' +
				( o.star ? 'is-starred' : '' ) +
				'">★</button>';
			const colorBtn =
				'<button type="button" data-color="' +
				o.termId +
				'" data-current="' +
				esc( o.color || '' ) +
				'" title="' + __( 'Folder color', 'plugnest-media-folders' ) + '">🎨</button>';
			const actions =
				o.termId !== undefined
					? '<span class="pnmf-tree-actions">' +
					  '<button type="button" data-rename="' +
					  o.termId +
					  '" title="' + __( 'Rename', 'plugnest-media-folders' ) + '">✎</button>' +
					  colorBtn +
					  starBtn +
					  rolesBtn +
					  '<button type="button" class="pnmf-danger" data-delete="' +
					  o.termId +
					  '" title="' + __( 'Delete', 'plugnest-media-folders' ) + '">✕</button>' +
					  '</span>'
					: '';

			return (
				'<li class="pnmf-tree-item' +
				( o.active ? ' is-active' : '' ) +
				( o.color ? ' is-colored' : '' ) +
				'" style="padding-left:' +
				pad +
				'px' +
				( o.color ? ';' + colVars( o.color ) : '' ) +
				'" data-key="' +
				o.key +
				'"' +
				( o.termId !== undefined ? ' data-term="' + o.termId + '"' : '' ) +
				'>' +
					toggle +
					colorDot +
					'<span class="pnmf-tree-name">' +
					esc( o.name ) +
					lockBadge +
					'</span>' +
				'<span class="pnmf-tree-count">' +
				esc( o.count || 0 ) +
				'</span>' +
				actions +
				'</li>'
			);
		}

		/* 上傳列的目標資料夾提示跟著目前瀏覽的資料夾走 */
		if ( typeof updateUploadTarget === 'function' ) {
			updateUploadTarget();
		}
	}

	/**
	 * 依收合狀態過濾出要顯示的資料夾（含子層判斷）。
	 */
	function visibleFolders() {
		const byId = {};
		state.folders.forEach( ( f ) => {
			byId[ f.term_id ] = f;
		} );

		return state.folders.filter( ( f ) => {
			let p = f.parent;
			let guard = 0;
			while ( p && byId[ p ] && guard < 30 ) {
				if ( state.collapsed.has( p ) ) {
					return false;
				}
				p = byId[ p ].parent;
				guard++;
			}
			return true;
		} );
	}

	/**
	 * 頁內上傳的目標資料夾 term_id（0 = 不指定，落在未分類）。
	 * IIFE 頂層宣告：renderTree 與上傳區塊都會用。
	 */
	function uploadTargetFolderId() {
		if ( state.folderId === 'none' || state.folderId === 0 ) {
			return 0;
		}
		return parseInt( state.folderId, 10 ) || 0;
	}

	/**
	 * 上傳列的目標資料夾提示（跟隨目前瀏覽的資料夾）。
	 */
	function updateUploadTarget() {
		const el = document.querySelector( '#pnmf-upload-target' );
		if ( ! el ) {
			return;
		}
		let name = __( 'All media (uploads land in Unassigned)', 'plugnest-media-folders' );
		if ( state.folderId === 'none' ) {
			name = __( 'Unassigned', 'plugnest-media-folders' );
		} else if ( state.folderId > 0 ) {
			const f = state.folders.find( ( x ) => x.term_id === parseInt( state.folderId, 10 ) );
			if ( f ) {
				name = f.name;
			}
		}
		el.textContent = name;
	}

	function renderTags() {
		const box = $( '#pnmf-tags' );
		if ( ! state.tags.length ) {
			box.innerHTML = '<span class="pnmf-hint">' + __( 'No tags yet.', 'plugnest-media-folders' ) + '</span>';
			return;
		}
		box.innerHTML = state.tags
			.map(
				( t ) =>
					'<span class="pnmf-tag' +
					( state.tagIds.indexOf( t.term_id ) >= 0 ? ' is-active' : '' ) +
					'" data-tag="' +
					t.term_id +
					'">' +
					esc( t.name ) +
					'<span class="pnmf-tag-count">' +
					esc( t.count ) +
					'</span></span>'
			)
			.join( '' );
	}

	/* =========================================================
	 *  媒體網格
	 * ========================================================= */

	function renderGrid( result ) {
		const grid = $( '#pnmf-grid' );
		state.items = result.items || [];
		state.total = result.total || 0;
		state.pages = result.pages || 1;

		grid.classList.toggle( 'pnmf-list', state.view === 'list' );
		renderFoldersBar();

		if ( ! state.items.length ) {
			grid.innerHTML = '<div class="pnmf-empty">' + esc( CFG.strings.noResult ) + '</div>';
			renderPagination();
			return;
		}

		grid.innerHTML = state.items
			.map( ( item ) => {
				const isSelected = state.selectAll || state.selected.has( item.id );
				const thumb = item.thumb
					/* draggable="false"：<img> 預設可拖，拖它時瀏覽器會在
					 * dataTransfer 塞入一個虛擬檔案（types 含 Files），
					 * 讓拖曳長得像「從桌面拖檔案進來」。關掉之後，拖縮圖
					 * 一律由外層 .pnmf-card[draggable] 接手，型別乾淨。 */
					? '<img src="' + esc( item.thumb ) + '" alt="" loading="lazy" draggable="false">'
					: '<span class="dashicons ' + iconOf( item.type ) + ' pnmf-card-icon"></span>';

				let flags = '';
				if ( item.used === 0 ) {
					flags += '<span class="pnmf-flag pnmf-flag--unused">' + __( 'Unused', 'plugnest-media-folders' ) + '</span>';
				} else if ( item.used === 1 ) {
					flags += '<span class="pnmf-flag pnmf-flag--used">' + __( 'In use', 'plugnest-media-folders' ) + '</span>';
				}
				if ( ! item.folders.length ) {
					flags += '<span class="pnmf-flag pnmf-flag--unassigned">' + __( 'Unassigned', 'plugnest-media-folders' ) + '</span>';
				}

				const folderLabel = item.folders.length
					? item.folders.map( ( f ) => f.name ).join( ', ' )
					: __( 'Unassigned', 'plugnest-media-folders' );

				const size = item.width && item.height ? item.width + '×' + item.height : item.ext;

				return (
					'<div class="pnmf-card' +
					( isSelected ? ' is-selected' : '' ) +
					'" data-id="' +
					item.id +
					'" draggable="true">' +
					'<div class="pnmf-card-thumb">' +
					thumb +
					'<span class="pnmf-card-check">✓</span>' +
					'<span class="pnmf-card-flags">' +
					flags +
					'</span>' +
					'<button type="button" class="pnmf-card-copy" data-url="' +
					esc( item.url ) +
					'" title="' + __( 'Copy URL', 'plugnest-media-folders' ) + '"><span class="dashicons dashicons-admin-links"></span></button>' +
					'</div>' +
					'<div class="pnmf-card-body">' +
					'<div class="pnmf-card-name" title="' +
					esc( item.filename || item.title ) +
					'">' +
					esc( item.filename || item.title ) +
					'</div>' +
					'<div class="pnmf-card-meta"><span>' +
					esc( item.filesize_human ) +
					'</span><span>' +
					esc( size ) +
					'</span><span class="pnmf-card-date">' +
					esc( item.date_human ) +
					'</span></div>' +
					'<div class="pnmf-card-folder' +
					( item.folders.length ? '' : ' is-none' ) +
					'" title="' +
					esc( folderLabel ) +
					'">' +
					esc( folderLabel ) +
					'</div>' +
					'</div>' +
					'</div>'
				);
			} )
			.join( '' );

		renderPagination();
		renderBulkbar();
	}

	function iconOf( type ) {
		if ( type === 'audio' ) {
			return 'dashicons-format-audio';
		}
		if ( type === 'video' ) {
			return 'dashicons-format-video';
		}
		if ( type === 'document' ) {
			return 'dashicons-media-document';
		}
		return 'dashicons-format-image';
	}

	/* =========================================================
	 *  資料夾磚（中間面板）
	 *
	 *  瀏覽「全部媒體」時顯示根層資料夾；進入資料夾則顯示其
	 *  子資料夾＋麵包屑。媒體卡可拖進磚裡歸類；從桌面拖檔案
	 *  進磚＝直接傳進該資料夾（與左側樹同一個 override 機制）。
	 * ========================================================= */

	function renderFoldersBar() {
		const bar = $( '#pnmf-folders' );
		if ( ! bar ) {
			return;
		}
		if ( state.folderId === 'none' ) {
			bar.hidden = true;
			bar.innerHTML = '';
			return;
		}

		const currentId = state.folderId > 0 ? parseInt( state.folderId, 10 ) : 0;
		const kids = state.folders
			.filter( ( f ) => ( f.parent || 0 ) === currentId )
			.sort( ( a, b ) => {
				/* 釘選優先，再按名稱。 */
				if ( !! a.star !== !! b.star ) {
					return a.star ? -1 : 1;
				}
				return a.name.localeCompare( b.name, undefined, { sensitivity: 'base' } );
			} );

		/* 麵包屑：目前資料夾往回走到根 */
		const byId = {};
		state.folders.forEach( ( f ) => {
			byId[ f.term_id ] = f;
		} );
		const crumbs = [];
		if ( currentId > 0 ) {
			let cur = byId[ currentId ];
			let guard = 0;
			while ( cur && guard < 20 ) {
				crumbs.unshift( cur );
				cur = byId[ cur.parent ];
				guard++;
			}
		}

		let html = '<nav class="pnmf-crumbs">';
		html +=
			'<button type="button" class="pnmf-crumb' +
			( currentId === 0 ? ' is-here' : '' ) +
			'" data-crumb="0">' +
			__( 'All media', 'plugnest-media-folders' ) +
			'</button>';
		crumbs.forEach( ( c, i ) => {
			html += '<span class="sep">›</span>';
			html +=
				'<button type="button" class="pnmf-crumb' +
				( i === crumbs.length - 1 ? ' is-here' : '' ) +
				'" data-crumb="' +
				c.term_id +
				'">' +
				esc( c.name ) +
				'</button>';
		} );
		html += '</nav>';

		html += '<div class="pnmf-tiles">';
		kids.forEach( ( f ) => {
			html +=
				'<button type="button" class="pnmf-folder-tile' +
				( f.color ? ' is-colored' : '' ) +
				'" data-tile="' +
				f.term_id +
				'" title="' +
				esc( f.name ) +
				'"' +
				( f.color ? ' style="' + colVars( f.color ) + '"' : '' ) +
				'>' +
				'<span class="dashicons dashicons-portfolio"></span>' +
				'<span class="pnmf-tile-name">' +
				( f.star ? '<span class="pnmf-tree-star">★</span>' : '' ) +
				esc( f.name ) +
				'</span>' +
				'<span class="pnmf-tile-count">' +
				esc( f.count || 0 ) +
				'</span>' +
				'</button>';
		} );
		html +=
			'<button type="button" class="pnmf-folder-tile is-add" data-tile-add="' +
			currentId +
			'" title="' +
			__( 'Add new folder', 'plugnest-media-folders' ) +
			'">' +
			'<span class="dashicons dashicons-plus-alt2"></span>' +
			'<span class="pnmf-tile-name">' +
			__( 'Add', 'plugnest-media-folders' ) +
			'</span>' +
			'</button>';
		html += '</div>';

		bar.hidden = false;
		bar.innerHTML = html;
	}

	/**
	 * 把目前選取（或正在拖曳）的媒體移動到指定資料夾（replace 語意）。
	 * 資料夾磚的投放目標；左側樹的 drop 走同一端點。
	 *
	 * @param {number}        folderId 目標資料夾 term_id。
	 * @param {DragEvent|null} evt      drop 事件（用來從 dataTransfer 還原 ID 清單）。
	 */
	async function moveSelectionToFolder( folderId, evt ) {
		const ids = ( state.dragIds && state.dragIds.length )
			? state.dragIds
			: ( ( evt && internalIds( evt ) ) || selectedIds() );
		const selectAll = state.selectAll && ! state.dragIds ? 1 : 0;
		state.dragIds = null;
		if ( ! ids.length && ! selectAll ) {
			return;
		}
		try {
			const data = await api(
				'bulk_folder',
				Object.assign(
					{ ids, select_all: selectAll, target_folder_id: folderId, mode: 'replace' },
					currentScope()
				)
			);
			toast( data.message, 'ok' );
			state.selected.clear();
			state.selectAll = false;
			await refresh( true );
		} catch ( err ) {
			toast( err.message, 'error' );
		}
	}

	function renderPagination() {
		const box = $( '#pnmf-pagination' );
		if ( state.total <= state.perPage ) {
			box.innerHTML =
				'<span class="pnmf-pagination-info">' +
				sprintf( __( '%d media in total', 'plugnest-media-folders' ), state.total ) +
				'</span>';
			return;
		}

		box.innerHTML =
			'<button type="button" class="button" data-page="' +
			( state.paged - 1 ) +
			'"' +
			( state.paged <= 1 ? ' disabled' : '' ) +
			'>' + __( 'Previous', 'plugnest-media-folders' ) + '</button>' +
			'<span class="pnmf-pagination-info">' +
			sprintf( __( 'Page %1$d of %2$d, %3$d media in total', 'plugnest-media-folders' ), state.paged, state.pages, state.total ) +
			'</span>' +
			'<button type="button" class="button" data-page="' +
			( state.paged + 1 ) +
			'"' +
			( state.paged >= state.pages ? ' disabled' : '' ) +
			'>' + __( 'Next', 'plugnest-media-folders' ) + '</button>';
	}

	/* =========================================================
	 *  批次操作列
	 * ========================================================= */

	function renderBulkbar() {
		const bar = $( '#pnmf-bulkbar' );
		const count = state.selectAll ? state.total : state.selected.size;

		bar.hidden = count === 0;
		$( '#pnmf-selected-count' ).textContent = count;

		if ( count === 0 ) {
			return;
		}

		/* 重建資料夾下拉，但保留使用者已選的值。 */
		const sel = $( '#pnmf-bulk-folder' );
		const previous = sel.value;
		const options = [ '<option value="">' + __( '— Select folder —', 'plugnest-media-folders' ) + '</option>' ];
		state.folders.forEach( ( f ) => {
			options.push(
				'<option value="' +
					f.term_id +
					'">' +
					esc( '　'.repeat( f.depth ) + f.name ) +
					'</option>'
			);
		} );
		sel.innerHTML = options.join( '' );
		sel.value = previous;
	}

	/* =========================================================
	 *  詳細面板
	 * ========================================================= */

	async function openInspector( id ) {
		try {
			const item = await api( 'get_item', { id } );
			state.current = item;
			renderInspector( item );
		} catch ( e ) {
			toast( e.message, 'error' );
		}
	}

	function renderInspector( item ) {
		/* 切換媒體前，先停掉上一個正在播放的音頻／視頻 */
		document
			.querySelectorAll( '#pnmf-inspector-body audio, #pnmf-inspector-body video' )
			.forEach( ( el ) => {
				try {
					el.pause();
				} catch ( e ) {}
			} );
		if ( document.fullscreenElement ) {
			document.exitFullscreen().catch( () => {} );
		}

		$( '#pnmf-inspector-empty' ).hidden = true;
		const body = $( '#pnmf-inspector-body' );
		body.hidden = false;

		/* 預覽：圖片顯示原圖；音頻／視頻給原生播放器（可播放／暫停、
		 * 視頻另有全螢幕鈕）；其他類型維持圖示。 */
		let preview = '';
		if ( item.type === 'audio' ) {
			preview =
				'<div class="pnmf-inspector-preview pnmf-preview-audio">' +
				'<span class="dashicons ' + iconOf( item.type ) + '"></span>' +
				'<audio controls preload="none" src="' + esc( item.url ) + '"></audio>' +
				'</div>';
		} else if ( item.type === 'video' ) {
			preview =
				'<div class="pnmf-inspector-preview pnmf-preview-video">' +
				'<video controls preload="metadata" src="' + esc( item.url ) + '"></video>' +
				'</div>';
		} else if ( item.thumb ) {
			preview = '<div class="pnmf-inspector-preview"><img src="' + esc( item.url ) + '" alt=""></div>';
		} else {
			preview = '<div class="pnmf-inspector-preview"><span class="dashicons ' + iconOf( item.type ) + '"></span></div>';
		}

		const folderOptions = [ '<option value="">' + __( '— Unassigned —', 'plugnest-media-folders' ) + '</option>' ]
			.concat(
				state.folders.map(
					( f ) =>
						'<option value="' +
						f.term_id +
						'"' +
						( item.folders.some( ( x ) => x.term_id === f.term_id ) ? ' selected' : '' ) +
						'>' +
						esc( '　'.repeat( f.depth ) + f.name ) +
						'</option>'
				)
			)
			.join( '' );

		const tagChips = state.tags
			.map(
				( t ) =>
					'<span class="pnmf-tag' +
					( item.tags.some( ( x ) => x.term_id === t.term_id ) ? ' is-active' : '' ) +
					'" data-inspector-tag="' +
					t.term_id +
					'">' +
					esc( t.name ) +
					'</span>'
			)
			.join( '' );

		const usageText =
			item.used === 1
				? '<span style="color:#007017">' + __( 'In use', 'plugnest-media-folders' ) + '</span>'
				: item.used === 0
				? '<span style="color:#b32d2e">' + __( 'Unused', 'plugnest-media-folders' ) + '</span>'
				: __( 'Not scanned', 'plugnest-media-folders' );

		body.innerHTML =
			preview +
			'<div class="pnmf-inspector-file">' +
			esc( item.filename ) +
			'</div>' +
			'<div class="pnmf-inspector-actions">' +
			'<a class="button button-small" href="' +
			esc( CFG.editUrl + '?post=' + item.id + '&action=edit' ) +
			'" target="_blank" rel="noopener">' + __( 'Open in native editor', 'plugnest-media-folders' ) + '</a>' +
			'<button type="button" class="button button-small" data-copy="' +
			esc( item.url ) +
			'">' + __( 'Copy URL', 'plugnest-media-folders' ) + '</button>' +
			'<button type="button" class="button button-small pnmf-danger-btn" data-inspector-delete="' +
			esc( item.id ) +
			'" title="' + __( 'Delete permanently (skips trash, cannot be undone)', 'plugnest-media-folders' ) + '">' + __( 'Delete permanently', 'plugnest-media-folders' ) + '</button>' +
			'</div>' +
			'<div class="pnmf-field-row"><label>' + __( 'Title', 'plugnest-media-folders' ) + '</label><input type="text" id="pnmf-f-title" value="' +
			esc( item.title ) +
			'"></div>' +
			'<div class="pnmf-field-row"><label>' + __( 'Alt text', 'plugnest-media-folders' ) + '</label><input type="text" id="pnmf-f-alt" value="' +
			esc( item.alt ) +
			'"></div>' +
			'<div class="pnmf-field-row"><label>' + __( 'Caption', 'plugnest-media-folders' ) + '</label><input type="text" id="pnmf-f-caption" value="' +
			esc( item.caption ) +
			'"></div>' +
			'<div class="pnmf-field-row"><label>' + __( 'Description', 'plugnest-media-folders' ) + '</label><textarea id="pnmf-f-desc">' +
			esc( item.description ) +
			'</textarea></div>' +
			'<div class="pnmf-field-row"><label>' + __( 'Folder', 'plugnest-media-folders' ) + '</label><select id="pnmf-f-folder">' +
			folderOptions +
			'</select></div>' +
			'<div class="pnmf-field-row"><label>' + __( 'Tags', 'plugnest-media-folders' ) + '</label><div class="pnmf-tags">' +
			( tagChips || '<span class="pnmf-hint">' + __( 'No tags yet.', 'plugnest-media-folders' ) + '</span>' ) +
			'</div></div>' +
			'<button type="button" class="button button-primary" id="pnmf-save-item">' + __( 'Save changes', 'plugnest-media-folders' ) + '</button>' +
			'<ul class="pnmf-meta-list">' +
			'<li>' + __( 'File size: ', 'plugnest-media-folders' ) + '<strong>' +
			esc( item.filesize_human ) +
			'</strong></li>' +
			'<li>' + __( 'Dimensions: ', 'plugnest-media-folders' ) + '<strong>' +
			esc( item.width && item.height ? item.width + ' × ' + item.height : '—' ) +
			'</strong></li>' +
			'<li>' + __( 'Type: ', 'plugnest-media-folders' ) + '<strong>' +
			esc( item.mime ) +
			'</strong></li>' +
			'<li>' + __( 'Uploaded: ', 'plugnest-media-folders' ) + '<strong>' +
			esc( item.date_human ) +
			'</strong></li>' +
			'<li>' + __( 'Usage: ', 'plugnest-media-folders' ) + '<strong>' +
			usageText +
			'</strong></li>' +
			'<li>ID: <strong>' +
			esc( item.id ) +
			'</strong></li>' +
			'</ul>';

		state.currentTags = item.tags.map( ( t ) => t.term_id );
	}

	async function saveCurrentItem() {
		if ( ! state.current ) {
			return;
		}

		const folderVal = $( '#pnmf-f-folder' ).value;

		const payload = {
			id: state.current.id,
			title: $( '#pnmf-f-title' ).value,
			alt: $( '#pnmf-f-alt' ).value,
			caption: $( '#pnmf-f-caption' ).value,
			description: $( '#pnmf-f-desc' ).value,
			folder_id: folderVal === '' ? 0 : folderVal,
			tag_ids: state.currentTags || [],
		};

		try {
			const item = await api( 'save_item', payload );
			state.current = item;
			renderInspector( item );
			toast( __( 'Saved.', 'plugnest-media-folders' ), 'ok' );
			await refresh( false );
		} catch ( e ) {
			toast( e.message, 'error' );
		}
	}

	/* =========================================================
	 *  資料載入
	 * ========================================================= */

	/*
	 * 媒體查詢的請求序號。
	 *
	 * 每次 loadMedia() 都遞增，回應回來時若已經不是最新的一次就整批丟棄。
	 * 沒有這個防護時，頁面剛載入的「全部媒體」請求可能比使用者搶先點的
	 * 那個資料夾還晚回來，把畫面上的結果蓋回舊的（左側已選 B，網格卻顯示全部）。
	 */
	let mediaReq = 0;

	async function loadMedia() {
		/* 重新載入會把卡片整個換掉，進行中的框選就沒有意義了。 */
		if ( marquee ) {
			marqueeCancel();
		}

		const grid = $( '#pnmf-grid' );
		grid.innerHTML = Array.from( { length: 12 } )
			.map( () => '<div class="pnmf-skeleton"></div>' )
			.join( '' );

		const req   = ++mediaReq;
		const parts = state.sort.split( '-' );

		try {
			const result = await api( 'load_media', {
				folder_id: state.folderId,
				include_children: state.includeChildren ? 1 : 0,
				tag_ids: state.tagIds,
				mime_group: state.mimeGroup,
				usage: state.usage,
				search: state.search,
				paged: state.paged,
				per_page: state.perPage,
				orderby: parts[ 0 ],
				order: parts[ 1 ],
			} );

			/* 已經有更新的請求發出，這次的結果就過期了，不要蓋掉畫面。 */
			if ( req !== mediaReq ) {
				return;
			}

			renderGrid( result );
		} catch ( e ) {
			if ( req !== mediaReq ) {
				return;
			}
			grid.innerHTML = '<div class="pnmf-empty">' + esc( e.message ) + '</div>';
		}
	}

	async function loadTree() {
		try {
			const data = await api( 'tree', {} );
			state.folders = data.folders || [];
			state.tags = data.tags || [];
			state.folderPaths = data.folder_paths || state.folderPaths;
			renderStats( data.stats || {} );
			renderTree();
			renderTags();
			renderBulkbar();
		} catch ( e ) {
			toast( e.message, 'error' );
		}
	}

	/**
	 * 重新整理（可選是否一併重載樹）。
	 *
	 * @param {boolean} withTree
	 */
	async function refresh( withTree ) {
		if ( withTree ) {
			await loadTree();
		}
		await loadMedia();
	}

	/* =========================================================
	 *  批次操作
	 * ========================================================= */

	function selectedIds() {
		return state.selectAll ? [] : Array.from( state.selected );
	}

	/**
	 * 從 dataTransfer 讀回內部拖曳的媒體 ID（採用自訂型別
	 * application/x-pnmf-media，由卡片 dragstart 寫入）。
	 *
	 * 正常情況用不到（state.dragIds 有值）；這是 dragstart 沒跑到、
	 * 或狀態被別處清掉時的還原路徑。dragover 期間瀏覽器基於安全
	 * 不給 getData，只有 drop 事件讀得到內容。
	 *
	 * @param {DragEvent} e
	 * @return {number[]|null}
	 */
	function internalIds( e ) {
		try {
			const raw = e.dataTransfer && e.dataTransfer.getData( 'application/x-pnmf-media' );
			if ( ! raw ) {
				return null;
			}
			const ids = JSON.parse( raw );
			if ( ! Array.isArray( ids ) ) {
				return null;
			}
			const clean = ids.map( ( v ) => parseInt( v, 10 ) ).filter( ( v ) => v > 0 );
			return clean.length ? clean : null;
		} catch ( err ) {
			return null;
		}
	}

	/**
	 * 目前的篩選條件（select_all 模式時，後端要靠這組條件重查）。
	 */
	function currentScope() {
		return {
			folder_id: state.folderId,
			include_children: state.includeChildren ? 1 : 0,
			tag_ids: state.tagIds,
			mime_group: state.mimeGroup,
			usage: state.usage,
			search: state.search,
		};
	}

	function toggleSelection( id, card ) {
		/* 一旦手動調整選取，就退出「全選」模式，改為明確清單。 */
		state.selectAll = false;

		if ( state.selected.has( id ) ) {
			state.selected.delete( id );
		} else {
			state.selected.add( id );
		}

		if ( card ) {
			card.classList.toggle( 'is-selected', state.selected.has( id ) );
		}
		renderBulkbar();
	}

	/* =========================================================
	 *  拉框選取
	 *
	 *  在網格「空白處」按下並拖曳 → 框選（卡片上的按下手勢完全讓給
	 *  原生拖曳與勾選，避免任何計時器與拖曳搶手勢）。
	 *
	 *  按住 Ctrl / Cmd / Shift 拉框 = 累加選取，否則為取代選取。
	 * ========================================================= */

	const MARQUEE_EDGE = 64; /* 自動捲動的感應邊界（px） */
	const MARQUEE_EDGE_MAX = 20; /* 自動捲動的最大速度（px / frame） */

	let marquee = null;
	let marqueeRaf = 0;
	let suppressClickUntil = 0;

	function marqueeBox() {
		let box = document.getElementById( 'pnmf-marquee' );
		if ( ! box ) {
			box = document.createElement( 'div' );
			box.id = 'pnmf-marquee';
			box.className = 'pnmf-marquee';
			box.hidden = true;
			document.body.appendChild( box );
		}
		return box;
	}

	function cancelHold() {
		/* 已無長按機制（卡片手勢全讓給拖曳/勾選），保留空函式供相容。 */
	}

	/**
	 * 開始框選。
	 *
	 * 卡片座標在開始時就換算成「文件座標」快取起來，
	 * 之後每一帧只做純數學比對，不必反覆讀取 getBoundingClientRect，
	 * 而且中途捲動頁面也不會錯位。
	 */
	function marqueeStart( x, y, additive, owner ) {
		const sx = window.scrollX;
		const sy = window.scrollY;

		marquee = {
			additive: !! additive,
			owner: owner || null,
			startX: x,
			startY: y,
			curX: x,
			curY: y,
			docX: x + sx,
			docY: y + sy,
			base: new Set( state.selected ),
			/* 若原本處於「全選」模式，累加框選時整頁都該維持選取。 */
			wasSelectAll: !! state.selectAll,
			page: new Set(),
			cards: [],
			gridTop: null,
			gridLeft: null,
		};
		marqueeResync();

		document.body.classList.add( 'pnmf-marquee-on' );
		marqueeBox().hidden = false;

		if ( ! marqueeRaf ) {
			marqueeRaf = window.requestAnimationFrame( marqueeLoop );
		}
	}

	/**
	 * 重新量測卡片位置。
	 *
	 * 框選途中版面可能位移——最常見的是「批次操作列」在第一張卡片被選中時
	 * 冒出來，把整個網格往下推。若沿用位移前的座標，選取範圍就會跟畫面上的
	 * 框差一截。這裡每帧只讀一次網格位置，真的變了才重量所有卡片。
	 */
	function marqueeResync() {
		const m = marquee;
		const grid = $( '#pnmf-grid' );
		const g = grid.getBoundingClientRect();
		const sx = window.scrollX;
		const sy = window.scrollY;
		const top = g.top + sy;
		const left = g.left + sx;

		if ( top === m.gridTop && left === m.gridLeft ) {
			return;
		}

		m.gridTop = top;
		m.gridLeft = left;
		m.cards = Array.from( grid.querySelectorAll( '.pnmf-card' ) ).map( ( el ) => {
			const r = el.getBoundingClientRect();
			return {
				el: el,
				id: parseInt( el.dataset.id, 10 ),
				/* 以目前的畫面狀態為基準，重新量測不會讓已選取的卡片跳掉 */
				on: el.classList.contains( 'is-selected' ),
				left: r.left + sx,
				top: r.top + sy,
				right: r.right + sx,
				bottom: r.bottom + sy,
			};
		} );
		m.page = new Set( m.cards.map( ( c ) => c.id ) );
	}

	/* 框選期間持續跑，順便處理「拖到視窗邊緣自動捲動」。 */
	function marqueeLoop() {
		marqueeRaf = 0;
		if ( ! marquee ) {
			return;
		}
		marqueeScroll();
		marqueeResync();
		marqueeDraw();
		marqueeRaf = window.requestAnimationFrame( marqueeLoop );
	}

	function marqueeScroll() {
		const m = marquee;
		const vh = window.innerHeight;
		let dy = 0;

		if ( m.curY < MARQUEE_EDGE ) {
			dy = -Math.ceil( ( ( MARQUEE_EDGE - m.curY ) / MARQUEE_EDGE ) * MARQUEE_EDGE_MAX );
		} else if ( m.curY > vh - MARQUEE_EDGE ) {
			dy = Math.ceil( ( ( m.curY - ( vh - MARQUEE_EDGE ) ) / MARQUEE_EDGE ) * MARQUEE_EDGE_MAX );
		}

		if ( dy ) {
			window.scrollBy( 0, dy );
		}
	}

	function marqueeDraw() {
		const m = marquee;
		const sx = window.scrollX;
		const sy = window.scrollY;

		const x1 = Math.min( m.startX, m.curX );
		const y1 = Math.min( m.startY, m.curY );
		const x2 = Math.max( m.startX, m.curX );
		const y2 = Math.max( m.startY, m.curY );

		const box = marqueeBox();
		box.style.left = x1 + 'px';
		box.style.top = y1 + 'px';
		box.style.width = x2 - x1 + 'px';
		box.style.height = y2 - y1 + 'px';

		/* 框選範圍換算成文件座標，才能跟快取的卡片座標直接比對。 */
		const d1x = Math.min( m.docX, m.curX + sx );
		const d2x = Math.max( m.docX, m.curX + sx );
		const d1y = Math.min( m.docY, m.curY + sy );
		const d2y = Math.max( m.docY, m.curY + sy );

		m.cards.forEach( ( c ) => {
			const hit = c.right >= d1x && c.left <= d2x && c.bottom >= d1y && c.top <= d2y;
			const on = hit || ( m.additive && ( m.base.has( c.id ) || m.wasSelectAll ) );
			if ( c.on !== on ) {
				c.on = on;
				c.el.classList.toggle( 'is-selected', on );
			}
		} );

		marqueePreview();
	}

	/* 框選過程中即時更新「已選 N 個」與批次操作列的可見度。 */
	function marqueePreview() {
		const m = marquee;

		/* 「全選」模式下累加框選，選取範圍不變，直接沿用總數。 */
		if ( m.wasSelectAll && m.additive ) {
			$( '#pnmf-bulkbar' ).hidden = state.total === 0;
			$( '#pnmf-selected-count' ).textContent = state.total;
			return;
		}

		let count = 0;

		m.base.forEach( ( id ) => {
			if ( ! m.page.has( id ) ) {
				count++;
			}
		} );
		m.cards.forEach( ( c ) => {
			if ( c.on ) {
				count++;
			}
		} );

		$( '#pnmf-bulkbar' ).hidden = count === 0;
		$( '#pnmf-selected-count' ).textContent = count;
	}

	function marqueeEnd() {
		const m = marquee;
		marquee = null;

		document.body.classList.remove( 'pnmf-marquee-on' );
		marqueeBox().hidden = true;
		restoreDraggable( m );
		suppressClickUntil = Date.now() + 300;

		/* 「全選」＋累加框選 → 等於沒有變化，維持原本的全選狀態。 */
		if ( m.wasSelectAll && m.additive ) {
			state.selectAll = true;
			state.selected = m.base;
			m.cards.forEach( ( c ) => c.el.classList.add( 'is-selected' ) );
			renderBulkbar();
			return;
		}

		const next = new Set( m.base );
		if ( ! m.additive ) {
			m.page.forEach( ( id ) => next.delete( id ) );
		}
		m.cards.forEach( ( c ) => {
			if ( c.on ) {
				next.add( c.id );
			}
		} );

		state.selectAll = false;
		state.selected = next;

		m.cards.forEach( ( c ) => c.el.classList.toggle( 'is-selected', next.has( c.id ) ) );

		renderBulkbar();
	}

	/* 中途放棄框選（Esc）：還原成框選前的狀態。 */
	function marqueeCancel() {
		const m = marquee;
		marquee = null;

		document.body.classList.remove( 'pnmf-marquee-on' );
		marqueeBox().hidden = true;

		m.cards.forEach( ( c ) => c.el.classList.toggle( 'is-selected', m.base.has( c.id ) ) );

		restoreDraggable( m );
		suppressClickUntil = Date.now() + 300;
		renderBulkbar();
	}

	function restoreDraggable( m ) {
		if ( m.owner ) {
			m.owner.draggable = true;
		}
	}

	async function doBulk( kind ) {
		const ids = selectedIds();
		const selectAll = state.selectAll ? 1 : 0;

		if ( ! ids.length && ! selectAll ) {
			toast( CFG.strings.noSelection, 'error' );
			return;
		}

		const base = Object.assign( { ids, select_all: selectAll }, currentScope() );

		try {
			let data;

			if ( kind === 'folder-move' || kind === 'folder-add' ) {
				const folderId = $( '#pnmf-bulk-folder' ).value;
				if ( ! folderId ) {
					toast( __( 'Select a target folder first.', 'plugnest-media-folders' ), 'error' );
					return;
				}
				data = await api(
					'bulk_folder',
					Object.assign( {}, base, {
						target_folder_id: folderId,
						mode: kind === 'folder-add' ? 'add' : 'replace',
					} )
				);
			} else if ( kind === 'folder-clear' ) {
				data = await api( 'bulk_folder', Object.assign( {}, base, { mode: 'clear' } ) );
			} else if ( kind === 'media-delete' ) {
				/* 破壞性操作：二次確認。可見的選取媒體若有「使用中」，特別警示。 */
				const usedCount = state.items.filter(
					( i ) => state.selected.has( i.id ) && i.used === 1
				).length;

				let msg = selectAll
					? sprintf( __( 'Permanently delete ALL %d matching media?\nThe files and all thumbnails will be removed. This cannot be undone!', 'plugnest-media-folders' ), state.total )
					: sprintf( __( 'Permanently delete %d media?\nThe files and all thumbnails will be removed. This cannot be undone!', 'plugnest-media-folders' ), ids.length );
				if ( usedCount > 0 ) {
					msg += '\n\n' + sprintf( __( 'Warning: %d of them are in use by posts; deleting will leave missing images in your content.', 'plugnest-media-folders' ), usedCount );
				}
				if ( ! window.confirm( msg ) ) {
					return;
				}

				data = await api( 'media_delete', base );
			} else if ( kind === 'tag-add' || kind === 'tag-remove' ) {
				const names = $( '#pnmf-bulk-tags' ).value.trim();
				if ( ! names ) {
					toast( __( 'Enter tag names.', 'plugnest-media-folders' ), 'error' );
					return;
				}
				data = await api(
					'bulk_tag',
					Object.assign( {}, base, {
						tag_names: names,
						mode: kind === 'tag-remove' ? 'remove' : 'add',
					} )
				);
			} else if ( kind === 'bulk-edit' ) {
				const fields = {
					title: $( '#pnmf-edit-title' ).value,
					alt: $( '#pnmf-edit-alt' ).value,
					caption: $( '#pnmf-edit-caption' ).value,
					description: $( '#pnmf-edit-desc' ).value,
				};
				if ( ! fields.title && ! fields.alt && ! fields.caption && ! fields.description ) {
					toast( __( 'Fill in at least one field.', 'plugnest-media-folders' ), 'error' );
					return;
				}
				data = await api(
					'bulk_edit',
					Object.assign( {}, base, {
						fields,
						mode: $( '#pnmf-edit-mode' ).value,
					} )
				);
			}

			if ( data && data.message ) {
				toast( data.message, 'ok' );
			}

			state.selected.clear();
			state.selectAll = false;
			await refresh( true );

			if ( state.current ) {
				openInspector( state.current.id );
			}
		} catch ( e ) {
			toast( e.message, 'error' );
		}
	}

	/* =========================================================
	 *  資料夾 / 標籤 CRUD
	 * ========================================================= */

	/**
	 * 資料夾顏色彈出層：8 色快速色板＋原生調色盤自訂。含關閉鈕、
	 * 選定後自動關閉；點外面／Esc 也可關閉。
	 */
	const COLOR_SWATCHES = [ '', '#e65054', '#dba617', '#00a32a', '#2271b1', '#7a2ee6', '#f06fa0', '#646970' ];

	function openColorPop( anchor ) {
		let pop = document.getElementById( 'pnmf-color-pop' );
		if ( ! pop ) {
			pop = document.createElement( 'div' );
			pop.id = 'pnmf-color-pop';
			pop.className = 'pnmf-color-pop';
			document.body.appendChild( pop );

			document.addEventListener( 'mousedown', ( e ) => {
				if ( ! pop.hidden && ! e.target.closest( '#pnmf-color-pop' ) && ! e.target.closest( '[data-color]' ) ) {
					pop.hidden = true;
				}
			} );
			document.addEventListener( 'keydown', ( e ) => {
				if ( 'Escape' === e.key && ! pop.hidden ) {
					pop.hidden = true;
				}
			} );
		}

		const termId  = parseInt( anchor.dataset.color, 10 );
		const current = anchor.dataset.current || '';
		pop.innerHTML =
			'<div class="pnmf-color-pop-head">' +
			'<span class="pnmf-color-pop-title">' + __( 'Folder color', 'plugnest-media-folders' ) + '</span>' +
			'<button type="button" class="pnmf-color-pop-close" title="' + __( 'Close', 'plugnest-media-folders' ) + '">✕</button>' +
			'</div>' +
			'<div class="pnmf-color-swatches">' +
			COLOR_SWATCHES.map( ( c ) =>
				'<button type="button" class="pnmf-color-swatch' +
				( c === current ? ' is-current' : '' ) +
				( '' === c ? ' is-none' : '' ) +
				'" style="' + ( c ? 'background:' + c : '' ) + '" data-swatch="' +
				c +
				'" title="' + ( c ? c : __( 'No color', 'plugnest-media-folders' ) ) + '"></button>'
			).join( '' ) +
			'</div>' +
			'<label class="pnmf-color-custom">' +
			__( 'Custom', 'plugnest-media-folders' ) +
			' <input type="color" value="' + ( current || '#2271b1' ) + '">' +
			'</label>';

		const close = () => {
			pop.hidden = true;
		};
		pop.querySelector( '.pnmf-color-pop-close' ).addEventListener( 'click', close );

		const apply = async ( color ) => {
			close();
			try {
				const d = await api( 'folder_color', {
					term_id: termId,
					color,
				} );
				state.folders = d.folders || state.folders;
				renderTree();
				renderFoldersBar();
				toast( d.message, 'ok' );
			} catch ( err ) {
				toast( err.message, 'error' );
			}
		};

		pop.querySelectorAll( '[data-swatch]' ).forEach( ( sw ) => {
			sw.addEventListener( 'click', () => apply( sw.dataset.swatch ) );
		} );
		pop.querySelector( 'input[type="color"]' ).addEventListener( 'change', ( e ) => apply( e.target.value ) );

		const r = anchor.getBoundingClientRect();
		pop.hidden = false;
		pop.style.left = Math.min( r.left, window.innerWidth - 220 ) + 'px';
		pop.style.top = r.bottom + 6 + 'px';
	}

	async function addFolder( parent ) {
		const name = window.prompt( __( 'New folder name:', 'plugnest-media-folders' ) );
		if ( ! name ) {
			return;
		}
		try {
			await api( 'folder_create', { name, parent: parent || 0 } );
			await loadTree();
			toast( __( 'Folder created.', 'plugnest-media-folders' ), 'ok' );
		} catch ( e ) {
			toast( e.message, 'error' );
		}
	}

	async function renameFolder( termId ) {
		const current = state.folders.find( ( f ) => f.term_id === termId );
		const name = window.prompt( __( 'New folder name:', 'plugnest-media-folders' ), current ? current.name : '' );
		if ( ! name ) {
			return;
		}
		try {
			await api( 'folder_rename', { term_id: termId, name } );
			await loadTree();
			toast( __( 'Folder renamed.', 'plugnest-media-folders' ), 'ok' );
		} catch ( e ) {
			toast( e.message, 'error' );
		}
	}

	async function deleteFolder( termId ) {
		const f = state.folders.find( ( x ) => x.term_id === termId );
		const count = f ? ( f.count || 0 ) : 0;

		/* 深刪除對話框為 Pro 功能：有媒體且 Pro 才走。 */
		if ( CFG.pro && count > 0 && window.PNMF_Pro ) {
			window.PNMF_Pro.deepDelete( termId, f ? f.name : '', count );
			return;
		}

		if ( ! window.confirm( CFG.strings.confirmDeleteFolder ) ) {
			return;
		}
		try {
			await api( 'folder_delete', { term_id: termId } );
			if ( state.folderId === termId ) {
				state.folderId = 0;
			}
			await refresh( true );
			toast( __( 'Folder deleted.', 'plugnest-media-folders' ), 'ok' );
		} catch ( e ) {
			toast( e.message, 'error' );
		}
	}

	

	async function addTag() {
		const name = window.prompt( __( 'New tag name:', 'plugnest-media-folders' ) );
		if ( ! name ) {
			return;
		}
		try {
			await api( 'tag_create', { name } );
			await loadTree();
			toast( __( 'Tag created.', 'plugnest-media-folders' ), 'ok' );
		} catch ( e ) {
			toast( e.message, 'error' );
		}
	}

	/* =========================================================
	 *  自動分類
	 * ========================================================= */

	function renderRules() {
		const box = $( '#pnmf-rules' );

		const pathOptions = state.folderPaths
			.map( ( p ) => '<option value="' + esc( p.path ) + '">' + esc( p.path ) + '</option>' )
			.join( '' );

		const datalist = '<datalist id="pnmf-folder-paths">' + pathOptions + '</datalist>';

		if ( ! state.rules.length ) {
			box.innerHTML =
				'<div class="pnmf-empty">' + __( 'No rules yet. Click "Add rule" below to start.', 'plugnest-media-folders' ) + '</div>' + datalist;
			return;
		}

		box.innerHTML =
			state.rules
				.map( ( rule, idx ) => {
				const m = rule.match || {};

				return (
					'<div class="pnmf-rule-card' +
					( rule.enabled ? '' : ' is-disabled' ) +
					'" data-index="' +
					idx +
					'">' +
					'<div class="pnmf-rule-head">' +
					'<label class="pnmf-check"><input type="checkbox" data-field="enabled"' +
					( rule.enabled ? ' checked' : '' ) +
					'>' + __( 'Enable', 'plugnest-media-folders' ) + '</label>' +
					'<input type="text" data-field="label" value="' +
					esc( rule.label ) +
					'" placeholder="' + __( 'Rule name', 'plugnest-media-folders' ) + '">' +
					'<button type="button" class="button button-small" data-rule-move="up">↑</button>' +
					'<button type="button" class="button button-small" data-rule-move="down">↓</button>' +
					'<button type="button" class="button button-small" data-rule-delete>' + __( 'Delete', 'plugnest-media-folders' ) + '</button>' +
					'</div>' +
					'<div class="pnmf-rule-grid">' +
					'<label>' + __( 'Filename contains (comma-separated, any)', 'plugnest-media-folders' ) + '<input type="text" data-match="filename_contains" value="' +
					esc( m.filename_contains || '' ) +
					'" placeholder="' + __( 'e.g. asmr,drama', 'plugnest-media-folders' ) + '"></label>' +
					'<label>' + __( 'File extensions (comma-separated)', 'plugnest-media-folders' ) + '<input type="text" data-match="ext_in" value="' +
					esc( m.ext_in || '' ) +
					'" placeholder="' + __( 'e.g. mp3,m4a', 'plugnest-media-folders' ) + '"></label>' +
					'<label>' + __( 'Filename regex (advanced, optional)', 'plugnest-media-folders' ) + '<input type="text" data-match="filename_regex" value="' +
					esc( m.filename_regex || '' ) +
					'" placeholder="' + __( 'e.g. ^3star-', 'plugnest-media-folders' ) + '"></label>' +
					'<label>' + __( 'Type', 'plugnest-media-folders' ) + '<select data-match="mime_group">' +
					option( '', __( 'Any', 'plugnest-media-folders' ), m.mime_group ) +
					option( 'image', __( 'Image', 'plugnest-media-folders' ), m.mime_group ) +
					option( 'audio', __( 'Audio', 'plugnest-media-folders' ), m.mime_group ) +
					option( 'video', __( 'Video', 'plugnest-media-folders' ), m.mime_group ) +
					option( 'document', __( 'Document', 'plugnest-media-folders' ), m.mime_group ) +
					'</select></label>' +
					'<label>' + __( 'Min width (px, 0 = any)', 'plugnest-media-folders' ) + '<input type="number" data-match="min_width" value="' +
					esc( m.min_width || 0 ) +
					'"></label>' +
					'<label>' + __( 'Year (0 = any)', 'plugnest-media-folders' ) + '<input type="number" data-match="year" value="' +
					esc( m.year || 0 ) +
					'"></label>' +
					'</div>' +
					'<div class="pnmf-rule-grid">' +
					'<label>' + __( 'Target folder (use / for nesting; folders are created automatically)', 'plugnest-media-folders' ) +
					'<input type="text" data-field="target_folder" list="pnmf-folder-paths" value="' +
					esc( rule.target_folder || '' ) +
					'" placeholder="' + __( 'e.g. Videos/ASMR', 'plugnest-media-folders' ) + '"></label>' +
					'<label>' + __( 'Also add tags (comma-separated, optional)', 'plugnest-media-folders' ) + '<input type="text" data-field="add_tags" value="' +
					esc( ( rule.add_tags || [] ).join( ',' ) ) +
					'"></label>' +
					'</div>' +
					'<div class="pnmf-rule-foot">' +
					'<label class="pnmf-check"><input type="checkbox" data-field="only_unassigned"' +
					( rule.only_unassigned ? ' checked' : '' ) +
					'>' + __( 'Only process unassigned media (recommended)', 'plugnest-media-folders' ) + '</label>' +
					'</div>' +
					'</div>'
				);
			} )
				.join( '' ) + datalist;

		function option( value, label, current ) {
			return (
				'<option value="' +
				value +
				'"' +
				( String( current || '' ) === value ? ' selected' : '' ) +
				'>' +
				label +
				'</option>'
			);
		}
	}

	/**
	 * 把畫面上的規則讀回物件。
	 */
	function collectRules() {
		const cards = document.querySelectorAll( '.pnmf-rule-card' );
		const rules = [];

		cards.forEach( ( card ) => {
			const get = ( sel ) => {
				const el = card.querySelector( sel );
				return el ? el.value : '';
			};
			const checked = ( sel ) => {
				const el = card.querySelector( sel );
				return el ? el.checked : false;
			};

			rules.push( {
				id: state.rules[ card.dataset.index ]
					? state.rules[ card.dataset.index ].id
					: undefined,
				label: get( '[data-field="label"]' ),
				enabled: checked( '[data-field="enabled"]' ),
				only_unassigned: checked( '[data-field="only_unassigned"]' ),
				match: {
					filename_contains: get( '[data-match="filename_contains"]' ),
					filename_regex: get( '[data-match="filename_regex"]' ),
					ext_in: get( '[data-match="ext_in"]' ),
					mime_group: get( '[data-match="mime_group"]' ),
					min_width: parseInt( get( '[data-match="min_width"]' ), 10 ) || 0,
					max_width: 0,
					year: parseInt( get( '[data-match="year"]' ), 10 ) || 0,
				},
				target_folder: get( '[data-field="target_folder"]' ),
				add_tags: get( '[data-field="add_tags"]' )
					.split( ',' )
					.map( ( s ) => s.trim() )
					.filter( Boolean ),
			} );
		} );

		return rules;
	}

	function autoScope() {
		const picked = document.querySelector( 'input[name="pnmf-auto-scope"]:checked' );
		const value = picked ? picked.value : 'all';

		const scope = {
			folder_id: 0,
			usage: '',
			mime_group: '',
			search: '',
		};

		if ( value === 'unassigned' ) {
			scope.folder_id = 'none';
		} else if ( value === 'image' || value === 'audio' || value === 'video' ) {
			scope.mime_group = value;
		}

		return scope;
	}

	async function saveRules( silent ) {
		try {
			const data = await api( 'auto_save_rules', {
				rules: JSON.stringify( collectRules() ),
			} );
			state.rules = data.rules || [];
			renderRules();
			if ( ! silent ) {
				toast( data.message || __( 'Rules saved.', 'plugnest-media-folders' ), 'ok' );
			}
			return true;
		} catch ( e ) {
			toast( e.message, 'error' );
			return false;
		}
	}

	async function previewAuto() {
		try {
			await saveRules( true );
			const data = await api( 'auto_preview', {
				rules: JSON.stringify( state.rules ),
				...autoScope(),
			} );
			renderPreview( data );
		} catch ( e ) {
			toast( e.message, 'error' );
		}
	}

	function renderPreview( data ) {
		const box = $( '#pnmf-preview' );
		box.hidden = false;

		const rows = data.rules
			.filter( ( r ) => r.count > 0 || r.skipped > 0 )
			.map( ( r ) => {
				const samples = r.samples.length
					? '<div class="pnmf-preview-samples">' + __( 'Examples:', 'plugnest-media-folders' ) + ' ' +
					  r.samples.map( ( s ) => esc( s.filename ) ).join( ', ' ) +
					  '</div>'
					: '';

				return (
					'<div class="pnmf-preview-row"><span>' +
					esc( r.label ) +
					' → <span class="pnmf-preview-target">' +
					esc( r.target ) +
					'</span></span><span><strong>' +
					esc( r.count ) +
					'</strong> ' + __( 'items', 'plugnest-media-folders' ) +
					( r.skipped ? sprintf( __( ' (skipped %d)', 'plugnest-media-folders' ), esc( r.skipped ) ) : '' ) +
					'</span></div>' +
					samples
				);
			} )
			.join( '' );

		box.innerHTML =
			'<div class="pnmf-preview-head">' + __( 'Dry run (nothing has been saved yet)', 'plugnest-media-folders' ) + '</div>' +
			( rows || '<div class="pnmf-preview-row">' + __( 'No media matches the current rules.', 'plugnest-media-folders' ) + '</div>' ) +
			'<div class="pnmf-preview-row"><span>' + __( 'Media in scope', 'plugnest-media-folders' ) + '</span><span><strong>' +
			esc( data.candidates ) +
			'</strong></span></div>' +
			'<div class="pnmf-preview-row"><span>' + __( 'No rule matched', 'plugnest-media-folders' ) + '</span><span><strong>' +
			esc( data.unmatched ) +
			'</strong></span></div>' +
			'<div class="pnmf-preview-row"><span>' + __( 'Skipped (already assigned)', 'plugnest-media-folders' ) + '</span><span><strong>' +
			esc( data.skipped ) +
			'</strong></span></div>' +
			'<div class="pnmf-preview-row"><span>' + __( 'Will be assigned', 'plugnest-media-folders' ) + '</span><span><strong>' +
			esc( data.will_apply ) +
			'</strong> ' + __( 'items', 'plugnest-media-folders' ) + '</span></div>';
	}

	async function applyAuto() {
		if ( ! window.confirm( CFG.strings.confirmApply ) ) {
			return;
		}

		const ok = await saveRules( true );
		if ( ! ok ) {
			return;
		}

		try {
			await api( 'auto_start', {
				rules: JSON.stringify( state.rules ),
				...autoScope(),
			} );

			progress( true, __( 'Auto-assigning…', 'plugnest-media-folders' ), 0, true );
			await runAutoSteps();
		} catch ( e ) {
			progress( false );
			toast( e.message, 'error' );
		}
	}

	async function runAutoSteps() {
		let done = false;
		let guard = 0;

		while ( ! done && guard < 500 ) {
			if ( autoCancelled ) {
				autoCancelled = false;
				progress( false );
				return;
			}

			guard++;
			const data = await api( 'auto_step', {} );

			const percent = data.total ? Math.round( ( data.processed / data.total ) * 100 ) : 100;
			progress(
				true,
				sprintf( __( 'Auto-assigning… %1$d / %2$d (assigned %3$d, skipped %4$d)', 'plugnest-media-folders' ), data.processed, data.total, data.applied, data.skipped ),
				percent,
				true
			);

			done = !! data.done;

			if ( done ) {
				progress( false );
				toast(
					sprintf( __( 'Auto-assign complete: %1$d assigned, %2$d skipped. Undo it from Activity Log if needed.', 'plugnest-media-folders' ), data.applied, data.skipped ),
					'ok'
				);
				$( '#pnmf-preview' ).hidden = true;
				closeModal( '#pnmf-modal-auto' );
				state.selected.clear();
				await refresh( true );
			}
		}

		if ( guard >= 500 ) {
			progress( false );
			toast( __( 'Too many batches; stopped. Run again to continue.', 'plugnest-media-folders' ), 'error' );
		}
	}

	/* =========================================================
	 *  資料夾統計面板
	 * ========================================================= */

	function fmtBytesLocal( n ) {
		n = parseInt( n, 10 ) || 0;
		if ( n < 1024 ) { return n + ' B'; }
		if ( n < 1048576 ) { return ( n / 1024 ).toFixed( 1 ) + ' KB'; }
		if ( n < 1073741824 ) { return ( n / 1048576 ).toFixed( 1 ) + ' MB'; }
		return ( n / 1073741824 ).toFixed( 2 ) + ' GB';
	}

	async function openFolderStats() {
		openModal( '#pnmf-modal-fstats' );
		const box = $( '#pnmf-fstats-list' );
		box.innerHTML = '<span class="pnmf-hint">' + __( 'Loading…', 'plugnest-media-folders' ) + '</span>';

		const nameOf = {};
		let walk = ( list ) => ( list || [] ).forEach( ( f ) => {
			nameOf[ f.term_id ] = ( f.depth > 0 ? '　'.repeat( f.depth ) : '' ) + f.name;
			if ( f.children && f.children.length ) {
				walk( f.children );
			}
		} );
		walk( state.folders );

		try {
			const data = await api( 'folder_stats', {} );
			const stats = data.stats || {};
			const rows = Object.keys( stats )
				.map( ( k ) => Object.assign( { term_id: parseInt( k, 10 ) }, stats[ k ] ) )
				.sort( ( a, b ) => b.bytes - a.bytes || b.total - a.total );

			if ( ! rows.length ) {
				box.innerHTML = '<div class="pnmf-empty">' + __( 'No media assigned yet.', 'plugnest-media-folders' ) + '</div>';
				return;
			}

			box.innerHTML =
				'<table class="pnmf-fstats-table"><thead><tr>' +
				'<th>' + __( 'Folder', 'plugnest-media-folders' ) + '</th>' +
				'<th>' + __( 'Media', 'plugnest-media-folders' ) + '</th>' +
				'<th>' + __( 'Images', 'plugnest-media-folders' ) + '</th>' +
				'<th>' + __( 'Videos', 'plugnest-media-folders' ) + '</th>' +
				'<th>' + __( 'Audio', 'plugnest-media-folders' ) + '</th>' +
				'<th>' + __( 'Docs', 'plugnest-media-folders' ) + '</th>' +
				'<th>' + __( 'Size', 'plugnest-media-folders' ) + '</th>' +
				'</tr></thead><tbody>' +
				rows
					.map(
						( r ) =>
							'<tr>' +
							'<td>' + esc( nameOf[ r.term_id ] || ( 'ID ' + r.term_id ) ) + '</td>' +
							'<td>' + r.total + '</td>' +
							'<td>' + r.images + '</td>' +
							'<td>' + r.videos + '</td>' +
							'<td>' + r.audio + '</td>' +
							'<td>' + r.other + '</td>' +
							'<td>' + fmtBytesLocal( r.bytes ) + '</td>' +
							'</tr>'
					)
					.join( '' ) +
				'</tbody></table>';
		} catch ( e ) {
			box.innerHTML = '<div class="pnmf-empty">' + esc( e.message ) + '</div>';
		}
	}

	/* =========================================================
	 *  智慧篩選器（儲存的檢視；per-user）
	 * ========================================================= */

	const SORTS = [ 'date-DESC', 'date-ASC', 'title-ASC', 'title-DESC', 'size-DESC', 'size-ASC', 'ID-DESC' ];

	function findFolderNode( termId ) {
		return state.folders.find( ( f ) => f.term_id === termId ) || null;
	}

	/** 進入資料夾時套用其預設排序（若有）。 */
	function applyFolderSort() {
		if ( typeof state.folderId !== 'number' || state.folderId <= 0 ) {
			return;
		}
		const node = findFolderNode( state.folderId );
		if ( node && node.sort && SORTS.indexOf( node.sort ) >= 0 ) {
			state.sort = node.sort;
			const sel = $( '#pnmf-sort' );
			if ( sel ) {
				sel.value = node.sort;
			}
		}
	}

	async function pinFolderSort() {
		if ( typeof state.folderId !== 'number' || state.folderId <= 0 ) {
			toast( __( 'Open a folder first to pin its default sort.', 'plugnest-media-folders' ), 'error' );
			return;
		}
		const node = findFolderNode( state.folderId );
		if ( ! node ) {
			return;
		}

		const removing = node.sort === state.sort;
		try {
			const d = await api( 'folder_sort', {
				term_id: state.folderId,
				sort: removing ? '' : state.sort,
			} );
			node.sort = removing ? '' : state.sort;
			toast( d.message || ( removing ? __( 'Folder default sort removed.', 'plugnest-media-folders' ) : __( 'Folder default sort saved.', 'plugnest-media-folders' ) ), 'ok' );
		} catch ( e ) {
			toast( e.message, 'error' );
		}
	}

	function renderViews() {
		const sel = $( '#pnmf-views' );
		if ( ! sel ) {
			return;
		}
		const current = sel.value;
		let html = '<option value="">' + __( 'Saved views…', 'plugnest-media-folders' ) + '</option>';
		html += state.views
			.map( ( v ) => '<option value="' + esc( v.id ) + '">' + esc( v.name ) + '</option>' )
			.join( '' );
		sel.innerHTML = html;
		if ( current ) {
			sel.value = current;
		}
	}

	/** 套用檢視：state + 控制項同步後重新載入。 */
	function applyView( id ) {
		const v = state.views.find( ( x ) => x.id === id );
		if ( ! v || ! v.scope ) {
			return;
		}
		const s = v.scope;

		state.folderId = ( 'none' === s.folder_id ) ? 'none' : ( parseInt( s.folder_id, 10 ) || 0 );
		state.includeChildren = ( s.include_children === 0 || s.include_children === false ) ? false : true;
		state.tagIds = Array.isArray( s.tag_ids ) ? s.tag_ids.map( Number ) : [];
		state.mimeGroup = s.mime_group || '';
		state.usage = s.usage || '';
		state.search = s.search || '';

		const search = $( '#pnmf-search' );
		if ( search ) { search.value = state.search; }
		const type = $( '#pnmf-type' );
		if ( type ) { type.value = state.mimeGroup; }
		const usage = $( '#pnmf-usage' );
		if ( usage ) { usage.value = state.usage; }
		const kids = $( '#pnmf-include-children' );
		if ( kids ) { kids.checked = state.includeChildren; }

		renderTree();
		renderTags();
		renderFoldersBar();

		state.paged = 1;
		state.selected.clear();
		state.selectAll = false;
		renderBulkbar();
		loadMedia();
	}

	async function saveView() {
		const name = window.prompt( __( 'Name this view (the current filters will be saved):', 'plugnest-media-folders' ) );
		if ( ! name || ! name.trim() ) {
			return;
		}
		try {
			const d = await api( 'views_save', {
				name: name.trim(),
				scope: JSON.stringify( currentScope() ),
			} );
			state.views = d.views || [];
			renderViews();
			$( '#pnmf-views' ).value = d.id || '';
			toast( d.message || sprintf( __( 'Saved view "%s".', 'plugnest-media-folders' ), name.trim() ), 'ok' );
		} catch ( e ) {
			toast( e.message, 'error' );
		}
	}

	async function deleteView() {
		const id = $( '#pnmf-views' ).value;
		if ( ! id ) {
			toast( __( 'Select a view to delete first.', 'plugnest-media-folders' ), 'error' );
			return;
		}
		const v = state.views.find( ( x ) => x.id === id );
		if ( ! window.confirm( sprintf( __( 'Delete the view "%s"?', 'plugnest-media-folders' ), v ? v.name : id ) ) ) {
			return;
		}
		try {
			const d = await api( 'views_delete', { id } );
			state.views = d.views || [];
			renderViews();
			toast( d.message || __( 'View deleted.', 'plugnest-media-folders' ), 'ok' );
		} catch ( e ) {
			toast( e.message, 'error' );
		}
	}

	/* =========================================================
	 *  使用狀態掃描
	 * ========================================================= */

	async function scanUsage() {
		try {
			progress( true, __( 'Analyzing site references…', 'plugnest-media-folders' ), 2, false );

			let offset = 0;
			let done = false;
			let guard = 0;
			let total = 0;

			while ( ! done && guard < 500 ) {
				guard++;
				const data = await api( 'usage_scan', {
					offset,
					limit: 200,
					rebuild: guard === 1 ? 1 : 0,
				} );

				total = data.total;
				offset = data.processed;
				done = !! data.done;

				const percent = total ? Math.round( ( offset / total ) * 100 ) : 100;
				progress( true, sprintf( __( 'Scanning usage… %1$d / %2$d', 'plugnest-media-folders' ), offset, total ), percent, false );
			}

			progress( false );
			toast( sprintf( __( 'Scan complete: %d media processed.', 'plugnest-media-folders' ), offset ), 'ok' );
			await refresh( true );
		} catch ( e ) {
			progress( false );
			toast( e.message, 'error' );
		}
	}

	/* =========================================================
	 *  重複檔偵測（偵測免費；清理按鈕只在 Pro 授權下由 pro-admin.js 綁定）
	 * ========================================================= */

	/** 位元組 → 可讀字串。 */
	function fmtBytes( n ) {
		n = parseInt( n, 10 ) || 0;
		if ( n < 1024 ) { return n + ' B'; }
		if ( n < 1048576 ) { return ( n / 1024 ).toFixed( 1 ) + ' KB'; }
		if ( n < 1073741824 ) { return ( n / 1048576 ).toFixed( 1 ) + ' MB'; }
		return ( n / 1073741824 ).toFixed( 2 ) + ' GB';
	}

	let lastDupeData = null;

	/** 目前選擇的保留策略（Pro 控制區的無線電；免費版固定 largest）。 */
	function dupeStrategy() {
		const r = document.querySelector( 'input[name="pnmf-dupe-keep"]:checked' );
		return r && r.value === 'newest' ? 'newest' : 'largest';
	}

	/** 同組內依策略選出「預設保留」的那一份（與後端規則一致）。 */
	function dupeKeeperId( items, strategy ) {
		let best = null;
		( items || [] ).forEach( ( it ) => {
			if ( ! best ) { best = it; return; }
			if ( strategy === 'newest' ) {
				const at = it.ts || 0, bt = best.ts || 0;
				if ( at > bt || ( at === bt && it.id < best.id ) ) { best = it; }
			} else {
				const as = it.size || 0, bs = best.size || 0;
				if ( as > bs || ( as === bs && it.id < best.id ) ) { best = it; }
			}
		} );
		return best ? best.id : 0;
	}

	/** 更新「已勾選 / 總數」與全選框狀態。 */
	function updateDupeCount() {
		const all = document.querySelectorAll( '.pnmf-dupe-del' );
		const checked = document.querySelectorAll( '.pnmf-dupe-del:checked' );
		const counter = document.getElementById( 'pnmf-dupe-selcount' );
		if ( counter ) {
			counter.textContent = checked.length + ' / ' + all.length;
		}
		const box = document.getElementById( 'pnmf-dupe-checkall' );
		if ( box ) {
			box.checked = all.length > 0 && checked.length === all.length;
			box.indeterminate = checked.length > 0 && checked.length < all.length;
		}
	}

	const refsCache = new Map();

	/** 引用明細：檔案網址＋引用它的文章／頁面（可點去編輯）。 */
	function refsHtml( d ) {
		const dims = ( d.width && d.height ) ? d.width + ' × ' + d.height : '';
		const size = d.size ? fmtBytes( d.size ) : '';
		let html = '<div class="pnmf-refs-head">' +
			'<code>' + esc( d.url ) + '</code>' +
			'<a class="button button-small" target="_blank" rel="noopener" href="' + esc( d.url ) + '">' + __( 'Open', 'plugnest-media-folders' ) + '</a>' +
			'<span class="pnmf-hint">' + esc( [ dims, d.mime, size ].filter( Boolean ).join( ' · ' ) ) + '</span>' +
			'</div>';

		if ( ! d.count ) {
			return html + '<p class="pnmf-hint">' + __( 'No references found — the file may be used in custom fields, CSS backgrounds, or external embeds.', 'plugnest-media-folders' ) + '</p>';
		}

		const roleLabel = {
			featured: __( 'Featured image', 'plugnest-media-folders' ),
			elementor: 'Elementor',
			content: __( 'Post content', 'plugnest-media-folders' ),
		};
		html += '<ul class="pnmf-refs-list">';
		d.refs.forEach( ( r ) => {
			html += '<li>' +
				'<span class="pnmf-refs-role is-' + esc( r.role ) + '">' + esc( roleLabel[ r.role ] || r.role ) + '</span>' +
				'<a href="' + esc( r.edit ) + '">' + esc( r.title ) + '</a>' +
				'<span class="pnmf-hint">' + esc( r.type + ' · ' + r.status ) + '</span>' +
				( r.view ? '<a class="pnmf-refs-view" href="' + esc( r.view ) + '" target="_blank" rel="noopener">' + __( 'View', 'plugnest-media-folders' ) + '</a>' : '' ) +
				'</li>';
		} );
		html += '</ul>';
		if ( d.truncated ) {
			html += '<p class="pnmf-hint">' + __( 'Only the first 50 references are listed.', 'plugnest-media-folders' ) + '</p>';
		}
		return html;
	}

	/** 展開／收起某一列的引用明細。 */
	async function toggleDupeRefs( btn ) {
		const id = parseInt( btn.getAttribute( 'data-id' ), 10 );
		const row = btn.closest( '.pnmf-dupe-row' );
		if ( ! row || ! id ) { return; }

		const next = row.nextElementSibling;
		if ( next && next.classList && next.classList.contains( 'pnmf-dupe-refs' ) ) {
			next.remove();
			return;
		}

		const panel = document.createElement( 'div' );
		panel.className = 'pnmf-dupe-refs';
		panel.innerHTML = '<span class="pnmf-hint">' + __( 'Loading references…', 'plugnest-media-folders' ) + '</span>';
		row.insertAdjacentElement( 'afterend', panel );

		try {
			const data = refsCache.has( id ) ? refsCache.get( id ) : await api( 'dupe_refs', { id: id } );
			refsCache.set( id, data );
			panel.innerHTML = refsHtml( data );
		} catch ( e ) {
			panel.innerHTML = '<span class="pnmf-hint">' + esc( e.message ) + '</span>';
		}
	}

	/** 統計「使用中 / 未掃描」數量（決定要不要顯示保護提示）。 */
	function dupeUsageCounts( groups ) {
		let unscanned = 0;
		let inUse = 0;
		( groups || [] ).forEach( ( g ) => {
			( g.items || [] ).forEach( ( it ) => {
				const u = ( null === it.usage || typeof it.usage === 'undefined' ) ? '' : String( it.usage );
				if ( '' === u ) { unscanned++; } else if ( '1' === u ) { inUse++; }
			} );
		} );
		return { unscanned: unscanned, inUse: inUse };
	}

	/** 保護提示：告訴使用者「為什麼刪不掉」以及一鍵放行。 */
	function dupeBannerHtml( groups ) {
		if ( ! CFG.pro ) { return ''; }
		const c = dupeUsageCounts( groups );
		if ( ! c.inUse && ! c.unscanned ) { return ''; }

		const allow = document.getElementById( 'pnmf-dupe-include-used' );
		if ( allow && allow.checked ) {
			return '<div class="pnmf-dupe-unscanned is-allowed"><strong>' +
				__( 'In-use / unscanned copies are allowed. Post links will be rewritten to the kept copy.', 'plugnest-media-folders' ) +
				'</strong></div>';
		}

		const parts = [];
		if ( c.inUse ) {
			parts.push( 1 === c.inUse
				? __( '1 copy is in use', 'plugnest-media-folders' )
				: sprintf( __( '%d copies are in use', 'plugnest-media-folders' ), c.inUse ) );
		}
		if ( c.unscanned ) {
			parts.push( 1 === c.unscanned
				? __( '1 has never been scanned', 'plugnest-media-folders' )
				: sprintf( __( '%d have never been scanned', 'plugnest-media-folders' ), c.unscanned ) );
		}

		return '<div class="pnmf-dupe-unscanned"><strong>' +
			parts.join( ' · ' ) + ' — ' + __( 'protected by default.', 'plugnest-media-folders' ) +
			'</strong><button type="button" class="button button-small" id="pnmf-dupe-allow-used">' +
			__( 'Allow deleting them', 'plugnest-media-folders' ) + '</button>' +
			( c.unscanned
				? '<button type="button" class="button-link" id="pnmf-dupe-scan-first">' + __( 'Scan usage first', 'plugnest-media-folders' ) + '</button>'
				: '' ) +
			'<span class="pnmf-hint">' + __( 'Links in posts are rewritten to the kept copy.', 'plugnest-media-folders' ) + '</span></div>';
	}

	/** 只更新提示區，不動勾選狀態。 */
	function renderDupeBanner( groups ) {
		const box = document.getElementById( 'pnmf-dupe-banner' );
		if ( ! box ) { return; }
		const html = dupeBannerHtml( groups );
		box.innerHTML = html;
		box.hidden = ! html;
	}

	/** 渲染重複群組；Pro 才有勾選框（預設只勾「非保留者」）。 */
	function renderDupeList( data ) {
		const list = $( '#pnmf-dupe-list' );
		if ( ! list ) { return; }
		const groups = ( data && data.groups ) || [];

		if ( ! groups.length ) {
			list.innerHTML = '<div class="pnmf-empty">' + __( 'Great! No duplicate files were found.', 'plugnest-media-folders' ) + '</div>';
			updateDupeCount();
			return;
		}

		const usageBadge = ( u ) => {
			if ( u === '1' ) { return '<span class="pnmf-dupe-badge is-used">' + __( 'In use', 'plugnest-media-folders' ) + '</span>'; }
			if ( u === '0' ) { return '<span class="pnmf-dupe-badge is-unused">' + __( 'Unused', 'plugnest-media-folders' ) + '</span>'; }
			return '<span class="pnmf-dupe-badge">' + __( 'Not scanned', 'plugnest-media-folders' ) + '</span>';
		};

		const strategy = dupeStrategy();

		list.innerHTML = groups.map( ( g ) => {
			const items = g.items || [];
			const total = items.reduce( ( a, it ) => a + ( it.size || 0 ), 0 );
			const keeperId = dupeKeeperId( items, strategy );

			const rows = items.map( ( it ) => {
				const isKeeper = it.id === keeperId;
				const pick = ( CFG.pro && ! it.blocked )
					? '<label class="pnmf-dupe-pick" title="' + esc( __( 'Tick the copies you want to delete', 'plugnest-media-folders' ) ) + '">' +
						'<input type="checkbox" class="pnmf-dupe-del" value="' + it.id + '"' + ( isKeeper ? '' : ' checked' ) + '></label>'
					: '';

				return (
					'<div class="pnmf-dupe-row' + ( isKeeper ? ' is-keeper' : '' ) + '"' + ( it.blocked ? ' data-blocked="1"' : '' ) + '>' +
					pick +
					( it.thumb
						? '<img class="pnmf-dupe-thumb" src="' + esc( it.thumb ) + '" alt="">'
						: '<span class="dashicons dashicons-media-default pnmf-dupe-thumb"></span>' ) +
					'<div class="pnmf-dupe-main">' +
					'<div class="pnmf-dupe-name">' + esc( it.filename || it.title || ( 'ID ' + it.id ) ) +
					( isKeeper && CFG.pro ? ' <span class="pnmf-dupe-badge is-keeper">' + __( 'Keep', 'plugnest-media-folders' ) + '</span>' : '' ) +
					'</div>' +
					'<div class="pnmf-dupe-meta">ID ' + it.id +
					' · ' + esc( it.date ) +
					' · ' + fmtBytes( it.size ) +
					'　' + usageBadge( it.usage ) +
					'</div>' +
					'</div>' +
					'<button type="button" class="button button-small pnmf-dupe-refs-btn" data-id="' + it.id + '">' + __( 'References', 'plugnest-media-folders' ) + '</button>' +
					'<a class="button button-small" href="' + esc( it.edit ) + '" target="_blank" rel="noopener">' + __( 'Edit', 'plugnest-media-folders' ) + '</a>' +
					'</div>'
				);
			} ).join( '' );

			return (
				'<div class="pnmf-dupe-group">' +
				'<div class="pnmf-dupe-group-head">' +
				sprintf( __( '%d identical copies', 'plugnest-media-folders' ), g.count ) +
				' — ' + sprintf( __( '%s total', 'plugnest-media-folders' ), fmtBytes( total ) ) +
				'</div>' +
				rows +
				'</div>'
			);
		} ).join( '' );

		if ( data.truncated ) {
			list.innerHTML += '<div class="pnmf-hint">' + __( 'More duplicate groups exist beyond the display limit.', 'plugnest-media-folders' ) + '</div>';
		}

		renderDupeBanner( groups );

		list.innerHTML =
			'<div class="pnmf-hint pnmf-dupe-summary">' +
			sprintf( __( '%1$d duplicate groups — %2$d redundant copies.', 'plugnest-media-folders' ), data.group_count, data.dupe_count ) +
			'</div>' +
			list.innerHTML;

		updateDupeCount();
	}

	/** 建立雜湊索引（分批）＋回報重複群組，渲染進 modal。 */
	/* ---------- 雜湊計算：有時間預算、可中止、顯示目前檔案 ---------- */
	const hashJob = { running: false, cancel: false };

	function hashDuration( sec ) {
		sec = Math.max( 0, Math.round( sec ) );
		if ( sec < 60 ) { return sprintf( __( '%d s', 'plugnest-media-folders' ), sec ); }
		const m = Math.floor( sec / 60 );
		const s = sec % 60;
		return s
			? sprintf( __( '%1$d min %2$d s', 'plugnest-media-folders' ), m, s )
			: sprintf( __( '%d min', 'plugnest-media-folders' ), m );
	}

	function renderHashProgress( processed, total, current, started ) {
		total = Math.max( 1, total );
		const pct = Math.min( 100, Math.round( ( processed / total ) * 100 ) );

		const fill = document.getElementById( 'pnmf-job-fill' );
		const count = document.getElementById( 'pnmf-job-count' );
		const eta = document.getElementById( 'pnmf-job-eta' );
		const file = document.getElementById( 'pnmf-job-file' );

		if ( fill ) { fill.style.width = pct + '%'; }
		if ( count ) { count.textContent = sprintf( __( '%1$d / %2$d hashed', 'plugnest-media-folders' ), processed, total ); }
		if ( eta ) {
			const sec = processed > 0 ? ( ( Date.now() - started ) / 1000 / processed ) * Math.max( 0, total - processed ) : 0;
			eta.textContent = sec > 0 ? sprintf( __( 'About %s left', 'plugnest-media-folders' ), hashDuration( sec ) ) : '';
		}
		if ( file ) { file.textContent = current ? sprintf( __( 'Processing: %s', 'plugnest-media-folders' ), current ) : ''; }
	}

	function hashTimeout( promise, ms ) {
		return Promise.race( [
			promise,
			new Promise( ( _, reject ) => setTimeout( () => reject( new Error( __( 'The server did not answer in time. The work may still be running — try again, or lower the batch size.', 'plugnest-media-folders' ) ) ), ms ) ),
		] );
	}

	async function runDupeScan( rebuild ) {
		/* 已在跑就不要再開一條，否則兩個迴圈會互相把計數疊上去。 */
		if ( hashJob.running ) { return; }

		const list = $( '#pnmf-dupe-list' );
		list.innerHTML = '<span class="pnmf-hint">' + __( 'Hashing files…', 'plugnest-media-folders' ) + '</span>';

		const panel = document.getElementById( 'pnmf-dupe-job' );
		const stop  = $( '#pnmf-hash-cancel' );
		const started = Date.now();

		hashJob.running = true;
		hashJob.cancel = false;
		if ( panel ) { panel.hidden = false; }
		if ( stop ) { stop.hidden = false; stop.disabled = false; stop.textContent = __( 'Stop', 'plugnest-media-folders' ); }

		let missing = -1;
		let processed = 0;
		let done = false;
		let cancelled = false;
		let guard = 0;
		let serverTotal = 0;
		let skipIds = [];
		let failedIds = [];
		let stuckIds = [];
		let batchBase = 0;

		/* 逐檔輪詢：讓「已計數」與「正在處理」都來自伺服器的同一份狀態。 */
		const pollHashState = async () => {
			try {
				const st = await api( 'dupe_hash_state', {} );
				if ( ! st || ! st.running ) { return; }
				renderHashProgress( batchBase + ( st.done || 0 ), serverTotal || st.total || 0, st.current || '', started );
			} catch ( e ) { /* 忽略 */ }
		};
		const hashStateTimer = setInterval( pollHashState, 800 );

		const rebuildBtn = $( '#pnmf-dupe-rebuild' );
		if ( rebuildBtn ) { rebuildBtn.disabled = true; }

		try {
			while ( ! done && guard < 5000 ) {
				if ( hashJob.cancel ) { cancelled = true; break; }
				guard++;

				const d = await hashTimeout( api( 'dupe_build', {
					limit: 80,
					rebuild: ( guard === 1 && rebuild ) ? 1 : 0,
					reset: guard === 1 ? 1 : 0,
					skip: skipIds,
				} ), 45000 );

				if ( d.cancelled ) { cancelled = true; break; }

				const did = d.processed || 0;
				processed += did;
				missing = d.missing || 0;
				serverTotal = d.total || serverTotal || ( processed + missing );
				done = !! d.done;

				batchBase = processed;
				renderHashProgress( processed, serverTotal, d.current || '', started );

				/*
				 * 有檔案寫不進雜湊時，把它們記下來並在後續批次跳過，
				 * 否則「ID 最小的優先」會讓整批卡在同樣幾個檔案上、其他檔案永遠排不到。
				 */
				if ( d.stuck_ids && d.stuck_ids.length ) {
					stuckIds = stuckIds.concat( d.stuck_ids );
					skipIds = skipIds.concat( d.stuck_ids );
				}

				if ( d.failed > 0 ) {
					const ids = d.failed_ids || [];
					failedIds = failedIds.concat( ids );
					skipIds = skipIds.concat( ids );

					/* 一次幾十個都失敗，多半是資料庫／快取問題：直接停下並說明。 */
					if ( d.failed > 50 ) {
						throw new Error( sprintf(
							__( 'Hashing stopped: %1$d files could not be saved to the database (IDs: %2$s). Check database write permissions, or disable the object cache and try again.', 'plugnest-media-folders' ),
							d.failed,
							ids.join( ', ' )
						) );
					}
				}

				/* 伺服器這批什麼都沒做、也沒完成：不要無限迴圈。 */
				if ( ! did && ! done ) {
					throw new Error( __( 'Hashing stopped unexpectedly — try running it again.', 'plugnest-media-folders' ) );
				}
			}
		} catch ( e ) {
			/* 超時／出錯時也通知伺服器停手，避免背景繼續跑。 */
			try { await api( 'dupe_build_cancel', {} ); } catch ( e2 ) { /* 忽略 */ }
			toast( e.message, 'error' );
			if ( stop ) { stop.hidden = true; }
			if ( panel ) { setTimeout( () => { if ( ! hashJob.running ) { panel.hidden = true; } }, 1500 ); }
			throw e;
		} finally {
			clearInterval( hashStateTimer );
			hashJob.running = false;
			if ( rebuildBtn ) { rebuildBtn.disabled = false; }
			if ( stop ) { stop.hidden = true; stop.disabled = false; stop.textContent = __( 'Stop', 'plugnest-media-folders' ); }
			/* 延後隱藏；若使用者馬上又按了重建，不要把新任務的面板關掉。 */
			if ( panel ) { setTimeout( () => { if ( ! hashJob.running ) { panel.hidden = true; } }, 1200 ); }
		}

		const badIds = Array.from( new Set( failedIds.concat( stuckIds ) ) );
		if ( badIds.length ) {
			toast( sprintf(
				__( '%1$d files could not be hashed (IDs: %2$s). The rest were hashed; these were skipped so the run could finish.', 'plugnest-media-folders' ),
				badIds.length,
				badIds.slice( 0, 10 ).join( ', ' )
			), 'error' );
		}

		if ( cancelled || ! done ) {
			toast( sprintf( __( 'Hashing stopped — %d files are still unhashed. Run it again to continue.', 'plugnest-media-folders' ), Math.max( 0, missing ) ), 'ok' );
			list.innerHTML = '<span class="pnmf-hint">' + __( 'Hashing stopped.', 'plugnest-media-folders' ) + '</span>';
			return;
		}

		if ( ! done ) {
			throw new Error( __( 'Too many batches; stopped. Run again to continue.', 'plugnest-media-folders' ) );
		}

		try {
			const data = await api( 'dupe_list', {} );
			const groups = data.groups || [];

			/* Pro 控制區只在授權有效時露出（清理邏輯全在 Pro 外掛）。 */
			const proCtrl = $( '#pnmf-dupe-pro-ctrl' );
			const freeHint = $( '#pnmf-dupe-free-hint' );
			if ( proCtrl ) { proCtrl.hidden = ! CFG.pro; }
			if ( freeHint ) { freeHint.hidden = !! CFG.pro; }

			if ( ! groups.length ) {
				list.innerHTML = '<div class="pnmf-empty">' + __( 'Great! No duplicate files were found.', 'plugnest-media-folders' ) + '</div>';
				return;
			}

			renderDupeList( data );
			lastDupeData = data;
		} catch ( e ) {
			list.innerHTML = '<div class="pnmf-empty">' + esc( e.message ) + '</div>';
		}
	}

	/* 中止雜湊計算：按鈕 + 關閉彈窗 + 離開頁面三種路徑都要能停。 */
	const hashStopBtn = document.getElementById( 'pnmf-hash-cancel' );
	if ( hashStopBtn ) {
		hashStopBtn.addEventListener( 'click', async () => {
			if ( ! hashJob.running ) { return; }
			hashJob.cancel = true;
			hashStopBtn.disabled = true;
			hashStopBtn.textContent = __( 'Stopping…', 'plugnest-media-folders' );
			try { await api( 'dupe_build_cancel', {} ); } catch ( e ) { /* 忽略 */ }
		} );
	}

	window.addEventListener( 'beforeunload', () => {
		if ( ! hashJob.running ) { return; }
		try {
			const fd = new FormData();
			fd.append( 'action', 'pnmf_dupe_build_cancel' );
			fd.append( 'nonce', CFG.nonce );
			navigator.sendBeacon( CFG.ajaxUrl, fd );
		} catch ( e ) { /* 忽略 */ }
	} );

	document.addEventListener( 'click', ( e ) => {
		if ( ! hashJob.running ) { return; }
		const t = e.target;
		if ( ! t || ! t.closest ) { return; }
		if ( t.closest( '#pnmf-modal-dupe [data-close]' ) || t.closest( '#pnmf-modal-dupe .pnmf-modal-close' ) ) {
			e.preventDefault();
			e.stopPropagation();
			if ( window.confirm( __( 'Hashing is still running. Stop it and close?', 'plugnest-media-folders' ) ) ) {
				hashJob.cancel = true;
				api( 'dupe_build_cancel', {} ).catch( () => {} );
			}
		}
	}, true );

	function openDupes() {
		openModal( '#pnmf-modal-dupe' );
		const proCtrl = $( '#pnmf-dupe-pro-ctrl' );
		const freeHint = $( '#pnmf-dupe-free-hint' );
		if ( proCtrl ) { proCtrl.hidden = true; }
		if ( freeHint ) { freeHint.hidden = false; }
		runDupeScan( false ).catch( () => {} );
	}

	/* Pro 勾選：計數即時更新；切換「保留最大／最新」時重畫，改掉預設勾選。 */
	document.addEventListener( 'change', ( e ) => {
		const t = e.target;
		if ( ! t ) { return; }
		if ( t.id === 'pnmf-dupe-checkall' ) {
			document.querySelectorAll( '.pnmf-dupe-del' ).forEach( ( c ) => { c.checked = t.checked; } );
			updateDupeCount();
			return;
		}
		if ( t.id === 'pnmf-dupe-include-used' ) {
			renderDupeBanner( lastDupeData ? lastDupeData.groups : [] );
			return;
		}
		if ( t.classList && t.classList.contains( 'pnmf-dupe-del' ) ) {
			updateDupeCount();
			return;
		}
		if ( t.name === 'pnmf-dupe-keep' && lastDupeData ) {
			renderDupeList( lastDupeData );
		}
	} );

	/* 展開引用明細。 */
	document.addEventListener( 'click', ( e ) => {
		if ( e.target && e.target.classList && e.target.classList.contains( 'pnmf-dupe-refs-btn' ) ) {
			toggleDupeRefs( e.target );
		}
	} );

	/* 一鍵放行「使用中／未掃描」的副本。 */
	document.addEventListener( 'click', ( e ) => {
		if ( e.target && e.target.id === 'pnmf-dupe-allow-used' ) {
			const allow = document.getElementById( 'pnmf-dupe-include-used' );
			if ( allow ) {
				allow.checked = true;
				renderDupeBanner( lastDupeData ? lastDupeData.groups : [] );
			}
		}
	} );

	/* 「先掃描使用狀態」：關掉彈窗、觸發工具列的 Scan usage。 */
	document.addEventListener( 'click', ( e ) => {
		if ( e.target && e.target.id === 'pnmf-dupe-scan-first' ) {
			closeModal( '#pnmf-modal-dupe' );
			const btn = document.getElementById( 'pnmf-btn-scan' );
			if ( btn ) { btn.click(); }
		}
	} );

	/* Pro 清理完成後由 pro-admin.js 發事件，這裡重掃一次。 */
	document.addEventListener( 'pnmf:dupes-changed', () => {
		const modal = document.getElementById( 'pnmf-modal-dupe' );
		if ( modal && ! modal.hidden ) {
			runDupeScan( false ).catch( () => {} );
		}
	} );

	/* =========================================================
	 *  操作記錄
	 * ========================================================= */

	async function openLogs() {
		openModal( '#pnmf-modal-logs' );
		const box = $( '#pnmf-log-list' );
		box.innerHTML = '<div class="pnmf-loading">' + __( 'Loading…', 'plugnest-media-folders' ) + '</div>';

		try {
			const data = await api( 'log_list', { limit: 40 } );
			const logs = data.logs || [];

			if ( ! logs.length ) {
				box.innerHTML = '<div class="pnmf-empty">' + __( 'No activity yet.', 'plugnest-media-folders' ) + '</div>';
				return;
			}

			box.innerHTML = logs
				.map(
					( log ) =>
						'<div class="pnmf-log-item">' +
						'<div class="pnmf-log-main">' +
						'<div class="pnmf-log-action">' +
						esc( log.label ) +
						'　<span style="font-weight:400;color:#646970;">' +
						sprintf( __( '%d media', 'plugnest-media-folders' ), esc( log.object_count ) ) +
						'</span></div>' +
						'<div class="pnmf-log-meta">' +
						esc( log.created_at ) +
						'　·　' +
						esc( log.user_name ) +
						'</div>' +
						'</div>' +
						( parseInt( log.undone, 10 ) === 1
							? '<span class="pnmf-log-undone">' + __( 'Undone', 'plugnest-media-folders' ) + '</span>'
							: log.undoable
							? '<button type="button" class="button button-small" data-undo="' +
							  log.id +
							  '">' + __( 'Undo', 'plugnest-media-folders' ) + '</button>'
							: '<span class="pnmf-log-undone">' + __( 'Cannot undo', 'plugnest-media-folders' ) + '</span>' ) +
						'</div>'
				)
				.join( '' );
		} catch ( e ) {
			box.innerHTML = '<div class="pnmf-empty">' + esc( e.message ) + '</div>';
		}
	}

	async function undoLog( logId ) {
		if ( ! window.confirm( __( 'Undo this action?', 'plugnest-media-folders' ) ) ) {
			return;
		}
		try {
			const data = await api( 'log_undo', { log_id: logId } );
			toast( data.message || __( 'Undone.', 'plugnest-media-folders' ), 'ok' );
			await openLogs();
			await refresh( true );
		} catch ( e ) {
			toast( e.message, 'error' );
		}
	}

	/* =========================================================
	 *  對話框
	 * ========================================================= */

	function openModal( sel ) {
		const el = $( sel );
		if ( el ) {
			el.hidden = false;
		}
	}

	function closeModal( sel ) {
		const el = $( sel );
		if ( el ) {
			el.hidden = true;
		}
	}

	/**
	 * Pro 購買引導（免費版點鎖定功能時彈出）。
	 */
	function openUpsell() {
		const box = $( '#pnmf-upsell-features' );
		if ( box && ! box.dataset.filled ) {
			box.innerHTML = CFG.proFeatures
				.map( ( f ) => '<li>' + esc( f ) + '</li>' )
				.join( '' );
			box.dataset.filled = '1';
		}
		$( '#pnmf-upsell-buy' ).href = CFG.buyUrl;
		openModal( '#pnmf-modal-upsell' );
	}

	/* =========================================================
	 *  事件綁定
	 * ========================================================= */

	function bindEvents() {
		/* ---------- Pro 鎖定攔截（免費版：點 Pro 功能 → 購買引導）----------
		 * 捕獲階段攔截 .pnmf-pro-locked，擋在功能 handler 之前。 */
		document.addEventListener(
			'click',
			( e ) => {
				if ( CFG.pro ) {
					return;
				}
				const locked = e.target.closest( '.pnmf-pro-locked' );
				if ( locked ) {
					e.preventDefault();
					e.stopImmediatePropagation();
					openUpsell();
				}
			},
			true
		);

		/* ---------- 資料夾樹 ---------- */
		$( '#pnmf-tree' ).addEventListener( 'click', async ( e ) => {
			const toggle = e.target.closest( '[data-toggle]' );
			if ( toggle ) {
				const id = parseInt( toggle.dataset.toggle, 10 );
				if ( state.collapsed.has( id ) ) {
					state.collapsed.delete( id );
				} else {
					state.collapsed.add( id );
				}
				renderTree();
				return;
			}

			const rename = e.target.closest( '[data-rename]' );
			if ( rename ) {
				renameFolder( parseInt( rename.dataset.rename, 10 ) );
				return;
			}

			/* 星標釘選（切換） */
			const starBtn = e.target.closest( '[data-star]' );
			if ( starBtn ) {
				try {
					const d = await api( 'folder_star', {
						term_id: parseInt( starBtn.dataset.star, 10 ),
						star: '1' === starBtn.dataset.starred ? 0 : 1,
					} );
					state.folders = d.folders || state.folders;
					renderTree();
					renderFoldersBar();
				} catch ( err ) {
					toast( err.message, 'error' );
				}
				return;
			}

			/* 資料夾顏色：小彈出色板 */
			const colorBtn = e.target.closest( '[data-color]' );
			if ( colorBtn ) {
				openColorPop( colorBtn );
				return;
			}

			const del = e.target.closest( '[data-delete]' );
			if ( del ) {
				deleteFolder( parseInt( del.dataset.delete, 10 ) );
				return;
			}

			/* 資料夾存取角色限制 */
			const rolesBtn = e.target.closest( '[data-roles]' );
			if ( rolesBtn ) {
				if ( window.PNMF_Pro ) { window.PNMF_Pro.openRoles( parseInt( rolesBtn.dataset.roles, 10 ) ); } else { openUpsell(); }
				return;
			}

			const row = e.target.closest( '.pnmf-tree-item' );
			if ( ! row ) {
				return;
			}

			const key = row.dataset.key;
			/* 釘選列 key 為 'star-<id>' */
			if ( 0 === key.indexOf( 'star-' ) ) {
				state.folderId = parseInt( key.slice( 5 ), 10 );
			} else {
				state.folderId = key === 'all' ? 0 : key === 'none' ? 'none' : parseInt( key, 10 );
			}
			applyFolderSort();
			state.paged = 1;
			renderTree();
			loadMedia();
		} );

		/* 拖拉媒體到資料夾 = 移動；拖到「未分類」= 移出所有資料夾。
		 * 注意：後端 bulk_folder 的目標資料夾參數是 target_folder_id
		 * （與篩選用的 folder_id 區分），送錯鍵名會一直回「無效的目標資料夾」。
		 * 從作業系統拖「檔案」進來（上傳）是另一種手勢：types 含 Files，
		 * 資料夾列只做 override 標記，實際上傳交給 plupload 的整頁 dropzone。 */
		function isFileDrag( e ) {
			/* 內部拖動優先：只要是我們 dragstart 發起的，一律不算檔案拖動
			 * ——拖縮圖（<img>）時瀏覽器會把圖片以虛擬檔案塞進 dataTransfer
			 * （types 含 Files），外觀跟外部拖檔案一模一樣。判斷順序：
			 *   1) state.dragIds 已設（同一輪拖曳的即時狀態）
			 *   2) dataTransfer 帶我們的自訂型別（不依賴 transient 狀態）
			 * 兩者都沒有，才依 types 是否含 Files 判定為外部檔案。 */
			if ( state.dragIds && state.dragIds.length ) {
				return false;
			}
			if ( internalIds( e ) ) {
				return false;
			}
			try {
				const types = e.dataTransfer && e.dataTransfer.types;
				return !! types && Array.prototype.indexOf.call( types, 'Files' ) !== -1;
			} catch ( err ) {
				return false;
			}
		}

		$( '#pnmf-tree' ).addEventListener( 'dragover', ( e ) => {
			if ( isFileDrag( e ) ) {
				/* 檔案拖到資料夾列 → 該列即上傳目標，亮起來。 */
				const fRow = e.target.closest( '.pnmf-tree-item[data-term]' );
				if ( fRow ) {
					e.preventDefault();
					if ( e.dataTransfer ) {
						e.dataTransfer.dropEffect = 'copy';
					}
					document
						.querySelectorAll( '#pnmf-tree .is-drop-target' )
						.forEach( ( r ) => {
							if ( r !== fRow ) {
								r.classList.remove( 'is-drop-target' );
							}
						} );
					fRow.classList.add( 'is-drop-target' );
				}
				return;
			}

			const row = e.target.closest(
				'.pnmf-tree-item[data-term], .pnmf-tree-item[data-key="none"]'
			);
			if ( ! row ) {
				return;
			}
			e.preventDefault();
			if ( e.dataTransfer ) {
				e.dataTransfer.dropEffect = 'move';
			}
			/* 只亮目前這一列，離開的列要清掉 */
			document
				.querySelectorAll( '#pnmf-tree .is-drop-target' )
				.forEach( ( r ) => {
					if ( r !== row ) {
						r.classList.remove( 'is-drop-target' );
					}
				} );
			row.classList.add( 'is-drop-target' );
		} );

		$( '#pnmf-tree' ).addEventListener( 'dragleave', ( e ) => {
			if ( isFileDrag( e ) ) {
				return;
			}
			const row = e.target.closest(
				'.pnmf-tree-item[data-term], .pnmf-tree-item[data-key="none"]'
			);
			if ( row ) {
				row.classList.remove( 'is-drop-target' );
			}
		} );

		$( '#pnmf-tree' ).addEventListener( 'drop', async ( e ) => {
			const isFile = isFileDrag( e );

			/* 檔案拖到特定資料夾列上放開 → 標記 override，檔案會傳進該資料夾。
			 * 不 stopPropagation：事件續往上冒給 plupload 的整頁 dropzone 處理。 */
			if ( isFile ) {
				const fRow = e.target.closest( '.pnmf-tree-item[data-term]' );
				if ( fRow ) {
					e.preventDefault();
					state.uploadFolderOverride = parseInt( fRow.dataset.term, 10 ) || 0;
					fRow.classList.remove( 'is-drop-target' );
				}
				return;
			}

			const row = e.target.closest(
				'.pnmf-tree-item[data-term], .pnmf-tree-item[data-key="none"]'
			);
			if ( ! row ) {
				return;
			}
			e.preventDefault();
			row.classList.remove( 'is-drop-target' );
			/* 內部拖動到此為止：擋掉 wrap 上 plupload 的 drop（拖縮圖時
			 * 瀏覽器會附帶虛擬檔案，不擋會被撿去重新上傳）。 */
			e.stopPropagation();

			const ids = ( state.dragIds && state.dragIds.length )
				? state.dragIds
				: ( internalIds( e ) || selectedIds() );
			const selectAll = state.selectAll && ! state.dragIds ? 1 : 0;
			state.dragIds = null;
			if ( ! ids.length && ! selectAll ) {
				return;
			}

			const isNone = row.dataset.key === 'none';
			try {
				const data = await api(
					'bulk_folder',
					Object.assign( isNone
						? { ids, select_all: selectAll, mode: 'clear' }
						: {
							ids,
							select_all: selectAll,
							target_folder_id: parseInt( row.dataset.term, 10 ),
							mode: 'replace',
						}, currentScope() )
				);
				toast( data.message, 'ok' );
				state.selected.clear();
				state.selectAll = false;
				await refresh( true );
			} catch ( err ) {
				toast( err.message, 'error' );
			}
		} );

		/* ---------- 資料夾磚（中間面板） ---------- */
		const foldersBar = $( '#pnmf-folders' );
		if ( foldersBar ) {
			foldersBar.addEventListener( 'click', ( e ) => {
				const crumb = e.target.closest( '[data-crumb]' );
				if ( crumb ) {
					state.folderId = parseInt( crumb.dataset.crumb, 10 ) || 0;
					state.paged = 1;
					renderTree();
					loadMedia();
					return;
				}
				const add = e.target.closest( '[data-tile-add]' );
				if ( add ) {
					addFolder( parseInt( add.dataset.tileAdd, 10 ) || 0 );
					return;
				}
				const tile = e.target.closest( '[data-tile]' );
				if ( tile ) {
					state.folderId = parseInt( tile.dataset.tile, 10 );
					state.paged = 1;
					renderTree();
					loadMedia();
				}
			} );

			foldersBar.addEventListener( 'dragover', ( e ) => {
				const tile = e.target.closest( '[data-tile]' );
				foldersBar.querySelectorAll( '.is-drop-target' ).forEach( ( t ) => {
					if ( t !== tile ) {
						t.classList.remove( 'is-drop-target' );
					}
				} );
				if ( ! tile ) {
					return;
				}
				e.preventDefault();
				if ( e.dataTransfer && ! isFileDrag( e ) ) {
					e.dataTransfer.dropEffect = 'move';
				}
				tile.classList.add( 'is-drop-target' );
			} );

			foldersBar.addEventListener( 'dragleave', ( e ) => {
				const tile = e.target.closest( '[data-tile]' );
				if ( tile ) {
					tile.classList.remove( 'is-drop-target' );
				}
			} );

			foldersBar.addEventListener( 'drop', ( e ) => {
				const tile = e.target.closest( '[data-tile]' );
				if ( ! tile ) {
					return;
				}
				tile.classList.remove( 'is-drop-target' );

				if ( isFileDrag( e ) ) {
					/* 桌面檔案拖進磚 = 直接傳進該資料夾；不攔截事件，
					 * 讓 plupload 的整頁拖放區接手上傳。 */
					e.preventDefault();
					state.uploadFolderOverride = parseInt( tile.dataset.tile, 10 ) || 0;
					return;
				}

				e.preventDefault();
				/* 內部拖動到此為止（同樹列：防 plupload 撿走縮圖虛擬檔案）。 */
				e.stopPropagation();
				moveSelectionToFolder( parseInt( tile.dataset.tile, 10 ), e );
			} );
		}

		/* ---------- 標籤篩選 ---------- */
		$( '#pnmf-tags' ).addEventListener( 'click', ( e ) => {
			const tag = e.target.closest( '[data-tag]' );
			if ( ! tag ) {
				return;
			}
			const id = parseInt( tag.dataset.tag, 10 );
			const idx = state.tagIds.indexOf( id );
			if ( idx >= 0 ) {
				state.tagIds.splice( idx, 1 );
			} else {
				state.tagIds.push( id );
			}
			state.paged = 1;
			renderTags();
			loadMedia();
		} );

		/* ---------- 工具列 ---------- */
		$( '#pnmf-search' ).addEventListener(
			'input',
			debounce( ( e ) => {
				state.search = e.target.value;
				state.paged = 1;
				loadMedia();
			}, 350 )
		);

		$( '#pnmf-type' ).addEventListener( 'change', ( e ) => {
			state.mimeGroup = e.target.value;
			state.paged = 1;
			loadMedia();
		} );

		$( '#pnmf-usage' ).addEventListener( 'change', ( e ) => {
			state.usage = e.target.value;
			state.paged = 1;
			loadMedia();
		} );

		$( '#pnmf-sort' ).addEventListener( 'change', async ( e ) => {
			state.sort = e.target.value;
			state.paged = 1;

			/* 尺寸排序：索引未建滿時先分批補建（有進度提示）。 */
			if ( 0 === state.sort.indexOf( 'size-' ) && ( state.stats.filesize_missing || 0 ) > 0 ) {
				try {
					/* 不傳 offset：後端每次都取「尚未建索引」的最前面一批，
					 * 結果集會自己縮小；再累加位移反而會跳過一大段。 */
					let done = false;
					let guard = 0;
					while ( ! done && guard < 2000 ) {
						guard++;
						const d = await api( 'filesize_build', { limit: 300 } );
						done = d.done;
						progress(
							true,
							sprintf( __( 'Building file size index… %d remaining', 'plugnest-media-folders' ), d.missing ),
							0,
							false
						);
					}
					progress( false );
					const t = await api( 'tree', {} );
					state.stats = t.stats || state.stats;
				} catch ( err ) {
					progress( false );
					toast( err.message, 'error' );
				}
			}

			loadMedia();
		} );

		$( '#pnmf-include-children' ).addEventListener( 'change', ( e ) => {
			state.includeChildren = e.target.checked;
			state.paged = 1;
			loadMedia();
		} );

		/* ---------- 檢視模式切換（縮略圖 / 列表） ---------- */
		function applyView() {
			const grid = $( '#pnmf-grid' );
			if ( grid ) {
				grid.classList.toggle( 'pnmf-list', state.view === 'list' );
			}
			const gb = $( '#pnmf-view-grid' );
			const lb = $( '#pnmf-view-list' );
			if ( gb ) {
				gb.classList.toggle( 'is-active', state.view !== 'list' );
			}
			if ( lb ) {
				lb.classList.toggle( 'is-active', state.view === 'list' );
			}
		}

		$( '#pnmf-view-grid' ).addEventListener( 'click', () => {
			state.view = 'grid';
			localStorage.setItem( 'pnmf-view', 'grid' );
			applyView();
		} );

		$( '#pnmf-view-list' ).addEventListener( 'click', () => {
			state.view = 'list';
			localStorage.setItem( 'pnmf-view', 'list' );
			applyView();
		} );

		applyView();

		/* ---------- 網格：複製網址 ---------- */
		async function copyToClipboard( text ) {
			try {
				if ( navigator.clipboard && window.isSecureContext ) {
					await navigator.clipboard.writeText( text );
					return true;
				}
			} catch ( e ) {}

			/* 後備：暫存 textarea + execCommand（非安全連線環境用） */
			const ta = document.createElement( 'textarea' );
			ta.value = text;
			ta.style.position = 'fixed';
			ta.style.opacity = '0';
			document.body.appendChild( ta );
			ta.select();
			let ok = false;
			try {
				ok = document.execCommand( 'copy' );
			} catch ( e ) {
				ok = false;
			}
			ta.remove();
			return ok;
		}

		$( '#pnmf-grid' ).addEventListener( 'click', async ( e ) => {
			const btn = e.target.closest( '.pnmf-card-copy' );
			if ( ! btn ) {
				return;
			}
			e.preventDefault();
			e.stopImmediatePropagation();
			const ok = await copyToClipboard( btn.dataset.url );
			toast( ok ? __( 'URL copied to clipboard.', 'plugnest-media-folders' ) : __( 'Copy failed. Copy it manually from the details panel.', 'plugnest-media-folders' ), ok ? 'ok' : 'error' );
		} );

		/* ---------- 網格：選取與詳情 ---------- */
		let selAnchor = null; /* Shift 範圍選取的錨點（item id） */

		$( '#pnmf-grid' ).addEventListener( 'click', ( e ) => {
			/* 剛結束框選 → 忽略瀏覽器補上的這次 click */
			if ( Date.now() < suppressClickUntil ) {
				return;
			}

			/* 複製網址按鈕有自己的處理器 */
			if ( e.target.closest( '.pnmf-card-copy' ) ) {
				return;
			}

			const card = e.target.closest( '.pnmf-card' );
			if ( ! card ) {
				return;
			}
			const id = parseInt( card.dataset.id, 10 );

			/* 勾選框、或按住 Ctrl/Cmd → 切換選取，並設為範圍錨點 */
			if ( e.target.closest( '.pnmf-card-check' ) || e.ctrlKey || e.metaKey ) {
				toggleSelection( id, card );
				selAnchor = id;
				return;
			}

			/* Shift + 已有錨點 → 範圍選取（本頁可見順序） */
			if ( e.shiftKey && null !== selAnchor && selAnchor !== id ) {
				const ids = state.items.map( ( it ) => it.id );
				const a = ids.indexOf( selAnchor );
				const b = ids.indexOf( id );
				if ( a >= 0 && b >= 0 ) {
					state.selectAll = false;
					for ( let i = Math.min( a, b ); i <= Math.max( a, b ); i++ ) {
						state.selected.add( ids[ i ] );
					}
					document
						.querySelectorAll( '.pnmf-card' )
						.forEach( ( c ) => c.classList.toggle( 'is-selected', state.selected.has( parseInt( c.dataset.id, 10 ) ) ) );
					renderBulkbar();
					selAnchor = id;
					return;
				}
			}

			/* Shift 但沒有錨點 → 當作單一切換 */
			if ( e.shiftKey ) {
				toggleSelection( id, card );
				selAnchor = id;
				return;
			}

			/* 點卡片其他位置 → 開詳細面板（不動選取狀態）＋更新錨點 */
			openInspector( id );
			selAnchor = id;
		} );

		/* ---------- 網格：拉框選取 ---------- */
		$( '#pnmf-grid' ).addEventListener( 'mousedown', ( e ) => {
			if ( e.button !== 0 ) {
				return;
			}

			/* 勾選框與複製鈕自己會處理，不要搶手勢 */
			if ( e.target.closest( '.pnmf-card-check' ) || e.target.closest( '.pnmf-card-copy' ) ) {
				return;
			}

			const additive = e.ctrlKey || e.metaKey || e.shiftKey;
			const card = e.target.closest( '.pnmf-card' );

			/* 卡片上按下 → 什麼都不搶：短按是勾選、按住移動是原生拖曳。
			 * （曾有「長按 350ms 轉框選」的設計，但拖動前稍作停頓就會超過
			 * 門檻，框選接管後 draggable 被關、拖曳再也啟動不了——移除。
			 * 要框選請從網格空白處拖曳。） */
			if ( card ) {
				return;
			}

			/* 空白處 → 立即開始框選 */
			e.preventDefault();
			marqueeStart( e.clientX, e.clientY, additive, null );
		} );

		/* 框選期間的全域滑鼠事件 */
		document.addEventListener( 'mousemove', ( e ) => {
			if ( marquee ) {
				marquee.curX = e.clientX;
				marquee.curY = e.clientY;
			}
		} );

		document.addEventListener( 'mouseup', () => {
			if ( marquee ) {
				marqueeEnd();
			}
		} );

		/* 視窗失焦時 mouseup 可能收不到，補一道安全網避免框選卡住。 */
		window.addEventListener( 'blur', () => {
			if ( marquee ) {
				marqueeEnd();
			}
		} );

		/* 拖拉卡片 */
		$( '#pnmf-grid' ).addEventListener( 'dragstart', ( e ) => {
			/* 拖動優先：框選若在跑（或異常殘留）直接取消，讓拖曳放行——
			 * 舊行為是 preventDefault 擋掉拖曳，殘留的框選會永久殺死拖動。 */
			if ( marquee ) {
				marqueeCancel();
			}

			const card = e.target.closest( '.pnmf-card' );
			if ( ! card ) {
				return;
			}
			const id = parseInt( card.dataset.id, 10 );
			/* 拖的卡片在選取集合內 → 拖整個選取；否則只拖它自己 */
			state.dragIds = state.selected.has( id ) ? selectedIds() : [ id ];
			/* selectedIds() 在「跨頁全選」狀態下會回空陣列；空陣列的拖曳
			 * 在 drop 端會被當成「不是內部拖曳」。一律至少要有這一張。 */
			if ( ! state.dragIds.length ) {
				state.dragIds = [ id ];
			}
			e.dataTransfer.effectAllowed = 'move';
			/* Firefox 沒有 setData 不會啟動拖曳 */
			e.dataTransfer.setData( 'text/plain', String( id ) );
			/* 內部拖曳的可靠標記：state.dragIds 是 transient 狀態，dragstart
			 * 沒跑到或被清掉時，drop 只會看到 <img> 附帶的虛擬檔案而誤判成
			 * 「拖檔案進來上傳」。自訂型別寫進 dataTransfer，整個拖曳生命
			 * 週期（dragstart → dragover → drop）都讀得到。 */
			try {
				e.dataTransfer.setData( 'application/x-pnmf-media', JSON.stringify( state.dragIds ) );
			} catch ( err ) {}
			/* 左側樹進入「可投放」狀態 */
			const tree = document.querySelector( '#pnmf-tree' );
			if ( tree ) {
				tree.classList.add( 'pnmf-tree-droppable' );
			}
		} );

		window.addEventListener( 'dragend', () => {
			state.dragIds = null;
			const tree = document.querySelector( '#pnmf-tree' );
			if ( tree ) {
				tree.classList.remove( 'pnmf-tree-droppable' );
			}
			document
				.querySelectorAll( '#pnmf-tree .is-drop-target' )
				.forEach( ( r ) => r.classList.remove( 'is-drop-target' ) );
		} );

		/* ---------- 分頁 ---------- */
		$( '#pnmf-pagination' ).addEventListener( 'click', ( e ) => {
			const btn = e.target.closest( '[data-page]' );
			if ( ! btn ) {
				return;
			}
			const page = parseInt( btn.dataset.page, 10 );
			if ( page < 1 || page > state.pages ) {
				return;
			}
			state.paged = page;
			loadMedia();
			$( '#pnmf-grid' ).scrollIntoView( { behavior: 'smooth', block: 'start' } );
		} );

		/* ---------- 批次操作列 ---------- */
		$( '#pnmf-select-all' ).addEventListener( 'click', () => {
			state.selectAll = true;
			state.selected.clear();
			document
				.querySelectorAll( '.pnmf-card' )
				.forEach( ( c ) => c.classList.add( 'is-selected' ) );
			renderBulkbar();
			toast(
				sprintf( __( 'Selected all %d matching media (across pages).', 'plugnest-media-folders' ), state.total ),
				'ok'
			);
		} );

		$( '#pnmf-clear-selection' ).addEventListener( 'click', () => {
			state.selectAll = false;
			state.selected.clear();
			document
				.querySelectorAll( '.pnmf-card.is-selected' )
				.forEach( ( c ) => c.classList.remove( 'is-selected' ) );
			renderBulkbar();
		} );

		$( '#pnmf-bulkbar' ).addEventListener( 'click', ( e ) => {
			const btn = e.target.closest( '[data-bulk]' );
			if ( btn ) {
				doBulk( btn.dataset.bulk );
			}
		} );

		$( '#pnmf-toggle-edit' ).addEventListener( 'click', () => {
			const box = $( '#pnmf-bulk-edit' );
			box.hidden = ! box.hidden;
		} );

		$( '#pnmf-add-folder' ).addEventListener( 'click', () => {
			const parent =
				typeof state.folderId === 'number' && state.folderId > 0 ? state.folderId : 0;
			addFolder( parent );
		} );

		$( '#pnmf-add-tag' ).addEventListener( 'click', addTag );

		/* ---------- 詳細面板 ---------- */
		$( '#pnmf-inspector' ).addEventListener( 'click', async ( e ) => {
			if ( e.target.closest( '#pnmf-save-item' ) ) {
				saveCurrentItem();
				return;
			}

			/* 永久刪除（單個） */
			const delBtn = e.target.closest( '[data-inspector-delete]' );
			if ( delBtn ) {
				const id = parseInt( delBtn.dataset.inspectorDelete, 10 );
				const item = state.current;
				let msg = __( 'Permanently delete this media?\nThe files and all thumbnails will be removed. This cannot be undone!', 'plugnest-media-folders' );
				if ( item && item.used === 1 ) {
					msg += '\n\n' + __( 'Warning: this media is currently in use by posts; deleting will leave missing images in your content.', 'plugnest-media-folders' );
				}
				if ( ! window.confirm( msg ) ) {
					return;
				}
				try {
					const data = await api( 'media_delete', { ids: [ id ] } );
					toast( data.message, 'ok' );
					state.current = null;
					$( '#pnmf-inspector-empty' ).hidden = false;
					$( '#pnmf-inspector-body' ).hidden = true;
					await refresh( true );
				} catch ( err ) {
					toast( err.message, 'error' );
				}
				return;
			}

			const copy = e.target.closest( '[data-copy]' );
			if ( copy ) {
				const text = copy.dataset.copy;
				if ( navigator.clipboard && navigator.clipboard.writeText ) {
					navigator.clipboard
						.writeText( text )
						.then( () => toast( __( 'URL copied.', 'plugnest-media-folders' ), 'ok' ) )
						.catch( () => toast( __( 'Copy failed. Select and copy manually.', 'plugnest-media-folders' ), 'error' ) );
				} else {
					toast( __( 'Auto-copy is not supported in this browser. Select and copy manually.', 'plugnest-media-folders' ), 'error' );
				}
				return;
			}

			const tag = e.target.closest( '[data-inspector-tag]' );
			if ( tag ) {
				const id = parseInt( tag.dataset.inspectorTag, 10 );
				const idx = state.currentTags.indexOf( id );
				if ( idx >= 0 ) {
					state.currentTags.splice( idx, 1 );
				} else {
					state.currentTags.push( id );
				}
				tag.classList.toggle( 'is-active' );
			}
		} );

		/* ---------- 頂部按鈕 ---------- */
		$( '#pnmf-btn-scan' ).addEventListener( 'click', scanUsage );
		$( '#pnmf-btn-dupe' ).addEventListener( 'click', openDupes );
		$( '#pnmf-dupe-rebuild' ).addEventListener( 'click', () => {
			if ( window.confirm( __( 'Re-hash every file? This is slow on large libraries but catches files replaced outside WordPress.', 'plugnest-media-folders' ) ) ) {
				runDupeScan( true ).catch( () => {} );
			}
		} );

		/* ---------- 智慧篩選器 ---------- */
		renderViews();
		$( '#pnmf-views' ).addEventListener( 'change', ( e ) => {
			if ( e.target.value ) {
				applyView( e.target.value );
			}
		} );
		$( '#pnmf-view-save' ).addEventListener( 'click', saveView );
		$( '#pnmf-view-del' ).addEventListener( 'click', deleteView );
		$( '#pnmf-sort-pin' ).addEventListener( 'click', pinFolderSort );
		$( '#pnmf-btn-fstats' ).addEventListener( 'click', openFolderStats );

		/* ---------- 鍵盤快捷鍵 ---------- */
		document.addEventListener( 'keydown', ( e ) => {
			const t = e.target;
			const typing = t && ( 'INPUT' === t.tagName || 'TEXTAREA' === t.tagName || 'SELECT' === t.tagName || t.isContentEditable );

			/* Esc：關最上層 modal → 清除選取；正在跑進度時不干擾 */
			if ( 'Escape' === e.key ) {
				const progress = $( '#pnmf-progress' );
				if ( progress && ! progress.hidden ) {
					return;
				}
				const open = Array.from( document.querySelectorAll( '.pnmf-modal' ) ).filter( ( m ) => ! m.hidden ).pop();
				if ( open ) {
					open.hidden = true;
					e.preventDefault();
					return;
				}
				if ( ! typing && ( state.selected.size || state.selectAll ) ) {
					$( '#pnmf-clear-selection' ).click();
				}
				return;
			}

			if ( typing ) {
				return;
			}

			/* Ctrl/Cmd+K → 資料夾快速跳轉 */
			if ( ( e.ctrlKey || e.metaKey ) && 'k' === e.key.toLowerCase() ) {
				const inp = $( '#pnmf-tree-search' );
				if ( inp ) {
					e.preventDefault();
					inp.focus();
					inp.select();
				}
				return;
			}

			/* Ctrl/Cmd+A → 全選符合（與「Select all matching」一致） */
			if ( ( e.ctrlKey || e.metaKey ) && 'a' === e.key.toLowerCase() ) {
				e.preventDefault();
				$( '#pnmf-select-all' ).click();
				return;
			}

			/* Delete → 永久刪除（沿用既有確認流程） */
			if ( 'Delete' === e.key && ( state.selected.size || state.selectAll ) ) {
				const delBtn = document.querySelector( '[data-bulk="media-delete"]' );
				if ( delBtn ) {
					delBtn.click();
				}
			}
		} );

		$( '#pnmf-btn-logs' ).addEventListener( 'click', openLogs );

		/* ---------- 資料夾快速跳轉（Ctrl+K） ---------- */
		const tjInput = $( '#pnmf-tree-search' );
		const tjResults = $( '#pnmf-tree-search-results' );

		if ( tjInput && tjResults ) {
			tjInput.addEventListener( 'input', () => {
				const q = tjInput.value.trim().toLowerCase();
				if ( ! q ) {
					tjResults.hidden = true;
					tjResults.innerHTML = '';
					return;
				}
				const matches = state.folders
					.filter( ( f ) => ( f.name || '' ).toLowerCase().indexOf( q ) >= 0 )
					.slice( 0, 8 );
				tjResults.innerHTML = matches.length
					? matches
							.map(
								( f ) =>
									'<button type="button" class="pnmf-tj-item" data-tj="' + parseInt( f.term_id, 10 ) + '">' +
									esc( f.name ) +
									( f.count ? ' <span class="pnmf-tj-count">' + sprintf( __( '%d media', 'plugnest-media-folders' ), f.count ) + '</span>' : '' ) +
									'</button>'
							)
							.join( '' )
					: '<span class="pnmf-tj-empty">' + __( 'No matching folders.', 'plugnest-media-folders' ) + '</span>';
				tjResults.hidden = false;
			} );

			tjInput.addEventListener( 'keydown', ( e ) => {
				if ( 'Escape' === e.key ) {
					tjInput.value = '';
					tjResults.hidden = true;
					tjInput.blur();
				}
			} );

			tjResults.addEventListener( 'click', ( e ) => {
				const btn = e.target.closest( '[data-tj]' );
				if ( ! btn ) {
					return;
				}
				state.folderId = parseInt( btn.dataset.tj, 10 ) || 0;
				renderTree();
				renderFoldersBar();
				state.paged = 1;
				state.selected.clear();
				state.selectAll = false;
				renderBulkbar();
				tjInput.value = '';
				tjResults.hidden = true;
				loadMedia();
			} );

			document.addEventListener( 'click', ( e ) => {
				if ( ! e.target.closest( '.pnmf-tree-search' ) ) {
					tjResults.hidden = true;
				}
			} );
		}
		$( '#pnmf-btn-auto' ).addEventListener( 'click', () => {
			renderRules();
			openModal( '#pnmf-modal-auto' );
		} );

		/* ---------- 頁內上傳（方案 A 按鈕 + 方案 B 拖放區）----------
		 * 上傳完成偵測統一由 bindUploadCompletion() 驅動（FileUploaded 計數、
		 * UploadComplete 才刷新 —— 佇列的 add 是「排隊」不是「完成」）。 */
		let uploadedCount = 0;

		function bindUploadCompletion( wrapper ) {
			if ( ! wrapper || ! wrapper.uploader || wrapper.__mnCompletionBound ) {
				return;
			}
			wrapper.__mnCompletionBound = true;

			wrapper.uploader.bind( 'FileUploaded', () => {
				uploadedCount += 1;
			} );

			wrapper.uploader.bind( 'UploadComplete', async () => {
				const n = uploadedCount;
				uploadedCount = 0;
				state.uploadFolderOverride = 0; /* 整批完成才清一次性目標 */
				if ( n > 0 ) {
					await refresh( true );
					toast( sprintf( __( 'Uploaded %d media. The list and folders have been updated.', 'plugnest-media-folders' ), n ), 'ok' );
				}
				const bar = document.querySelector( '#pnmf-upload-progress' );
				if ( bar ) {
					bar.hidden = true;
				}
			} );

			wrapper.uploader.bind( 'Error', ( up, err ) => {
				toast( ( err && err.message ) ? sprintf( __( 'Upload failed: %s', 'plugnest-media-folders' ), err.message ) : __( 'Upload failed.', 'plugnest-media-folders' ), 'error' );
			} );
		}

		let uploadFrame = null;

		$( '#pnmf-btn-upload' ).addEventListener( 'click', () => {
			if ( typeof window.wp === 'undefined' || ! window.wp.media ) {
				toast( __( 'Media scripts are not loaded. Please reload the page.', 'plugnest-media-folders' ), 'error' );
				return;
			}
			uploadedCount = 0;

			if ( ! uploadFrame ) {
				uploadFrame = window.wp.media( {
					title: __( 'Upload media', 'plugnest-media-folders' ),
					frame: 'post',
					multiple: true,
				} );
				/* 開啟後直接停在「上傳文件」頁籤。 */
				uploadFrame.on( 'open', () => {
					window.setTimeout( () => {
						/* 上傳頁籤的標籤依核心 l10n 比對（任何語言都成立），
						 * 再以常見譯文與 /upload/ 正則後備。 */
						const l10n = window.wp.media.view && window.wp.media.view.l10n ? String( window.wp.media.view.l10n.uploadFiles || '' ) : '';
						window
							.jQuery( uploadFrame.$el.find( '.media-menu-item' ) )
							.filter( function () {
								const t = window.jQuery( this ).text();
								return (
									( l10n && t.indexOf( l10n ) !== -1 ) ||
									t.indexOf( '上传' ) !== -1 ||
									t.indexOf( '上傳' ) !== -1 ||
									/upload/i.test( t )
								);
							} )
							.first()
							.trigger( 'click' );
					}, 50 );
				} );
			}
			uploadFrame.open();
		} );

		/* ---------- 頁內上傳（方案 B）：plupload 拖放區 ----------
		 * 建構 wp.Uploader 包裝器實例（核心會處理 nonce/上限/mime，
		 * 並把完成的附件加進 wp.Uploader.queue）。
		 * 拖放範圍＝整個外掛頁面（.pnmf-wrap）：拖到哪個資料夾列就傳進
		 * 那個資料夾（uploadFolderOverride），其餘位置＝目前瀏覽的資料夾。
		 * updateUploadTarget / uploadTargetFolderId 在 IIFE 頂層（renderTree 也會呼叫）。 */
		if ( window.wp && window.wp.Uploader && window.plupload && CFG.uploadNonce ) {
			try {
				const mmUploader = new window.wp.Uploader( {
					container: document.getElementById( 'pnmf-upload-dropzone' ),
					browser:   document.getElementById( 'pnmf-upload-browse' ),
					dropzone:  document.querySelector( '.pnmf-wrap' ),
					params:    { pnmf_nonce: CFG.uploadNonce },
				} );

				if ( mmUploader.supported && mmUploader.uploader ) {
					bindUploadCompletion( mmUploader );

					/* 每個檔案上傳前：注入目標資料夾與歸類 nonce。
					 * 有 override（檔案拖到特定資料夾列上放開）用 override，
					 * 否則用目前瀏覽的資料夾。override 到 UploadComplete 才清，
					 * 多檔拖到同一個資料夾時整批都用同一個目標。 */
					mmUploader.uploader.bind( 'BeforeUpload', ( up ) => {
						const target = state.uploadFolderOverride || uploadTargetFolderId();
						const current = Object.assign(
							{},
							up.getOption ? up.getOption( 'multipart_params' ) : up.settings.multipart_params,
							{ pnmf_folder: String( target ), pnmf_nonce: CFG.uploadNonce }
						);
						up.setOption( 'multipart_params', current );
					} );

					mmUploader.uploader.bind( 'UploadProgress', ( up ) => {
						const bar = document.querySelector( '#pnmf-upload-progress' );
						if ( bar ) {
							bar.hidden = false;
							const fill = document.querySelector( '#pnmf-upload-progress-fill' );
							const text = document.querySelector( '#pnmf-upload-progress-text' );
							if ( fill ) {
								fill.style.width = up.total.percent + '%';
							}
							if ( text ) {
								text.textContent = sprintf( __( 'Uploading %1$d / %2$d (%3$d%%)', 'plugnest-media-folders' ), up.total.uploaded, up.total.count, up.total.percent );
							}
						}
					} );

					/* 暴露實例供除錯與測試 */
					window.PNMF.uploader = mmUploader;
				}
			} catch ( e ) {
				/* 環境不支援時靜默跳過，不影響其他功能。 */
			}

			/* 整頁都是拖放區的收尾：掉在頁面其他地方（側邊選單、管理列上）
			 * 也不要讓瀏覽器直接開啟檔案。 */
			window.addEventListener( 'dragover', ( e ) => {
				if ( e.dataTransfer && Array.prototype.indexOf.call( e.dataTransfer.types || [], 'Files' ) !== -1 ) {
					e.preventDefault();
				}
			} );
			window.addEventListener( 'drop', ( e ) => {
				if ( e.dataTransfer && Array.prototype.indexOf.call( e.dataTransfer.types || [], 'Files' ) !== -1 ) {
					e.preventDefault();
				}
			} );

			/* wp-plupload 用 dragover 模擬 dragenter 給上傳區加 drag-over（全頁
			 * 「放開即可上傳」遮罩），但不區分拖動來源——內部拖卡片也會亮遮罩。
			 * 它的 handler 在 plupload runtime 非同步初始化「之後」才掛上，
			 * 註冊順序永遠晚於我們 → 同步摘除贏不了它。
			 * 解法＝把摘除排進 rAF：本輪事件（含它的 add）全部跑完、
			 * 下一帧繪製之前執行 → 遮罩永遠畫不出來。
			 * 外部檔案拖動（types 含 Files）一律不動，遮罩照常。 */
			const mmWrap = document.querySelector( '.pnmf-wrap' );
			if ( mmWrap ) {
				const clearUploadMask = () => {
					mmWrap.classList.remove( 'drag-over' );
					const bar = document.querySelector( '.pnmf-uploadbar' );
					if ( bar ) {
						bar.classList.remove( 'drag-over', 'is-dragover' );
					}
				};
				mmWrap.addEventListener(
					'dragover',
					( e ) => {
						if ( isFileDrag( e ) ) {
							return;
						}
						requestAnimationFrame( clearUploadMask );
					},
					true
				);
				mmWrap.addEventListener( 'drop', ( e ) => {
					if ( isFileDrag( e ) ) {
						return;
					}
					requestAnimationFrame( clearUploadMask );
					/* 內部拖動掉在樹列／磚列以外：攔在 wrap 上，
					 * 防 plupload 把縮圖的虛擬檔案撿去上傳。
					 * （stopImmediate＝同一元素上後掛的 plupload handler 也不跑；
					 * 我們的 handler 同步註冊、它非同步晚掛，順序保證成立。） */
					e.stopImmediatePropagation();
				} );
			}
		}

		/* ---------- 自動分類對話框 ---------- */
		$( '#pnmf-preview-btn' ).addEventListener( 'click', previewAuto );
		$( '#pnmf-apply-btn' ).addEventListener( 'click', applyAuto );
		$( '#pnmf-save-rules' ).addEventListener( 'click', () => saveRules( false ) );

		$( '#pnmf-reset-rules' ).addEventListener( 'click', async () => {
			if ( ! window.confirm( __( 'Reset to the default rules? Your current rules will be overwritten.', 'plugnest-media-folders' ) ) ) {
				return;
			}
			try {
				const data = await api( 'auto_reset_rules', {} );
				state.rules = data.rules || [];
				renderRules();
				toast( data.message, 'ok' );
			} catch ( e ) {
				toast( e.message, 'error' );
			}
		} );

		$( '#pnmf-add-rule' ).addEventListener( 'click', () => {
			state.rules = collectRules();
			state.rules.push( {
				id: '',
				label: __( 'New rule', 'plugnest-media-folders' ),
				enabled: true,
				only_unassigned: true,
				match: {
					filename_contains: '',
					filename_regex: '',
					ext_in: '',
					mime_group: '',
					min_width: 0,
					max_width: 0,
					year: 0,
				},
				target_folder: '',
				add_tags: [],
			} );
			renderRules();
		} );

		$( '#pnmf-rules' ).addEventListener( 'click', ( e ) => {
			const card = e.target.closest( '.pnmf-rule-card' );
			if ( ! card ) {
				return;
			}
			const idx = parseInt( card.dataset.index, 10 );

			if ( e.target.closest( '[data-rule-delete]' ) ) {
				state.rules = collectRules();
				state.rules.splice( idx, 1 );
				renderRules();
				return;
			}

			const move = e.target.closest( '[data-rule-move]' );
			if ( move ) {
				state.rules = collectRules();
				const dir = move.dataset.ruleMove === 'up' ? -1 : 1;
				const target = idx + dir;
				if ( target >= 0 && target < state.rules.length ) {
					const tmp = state.rules[ idx ];
					state.rules[ idx ] = state.rules[ target ];
					state.rules[ target ] = tmp;
					renderRules();
				}
			}
		} );

		/* ---------- 操作記錄 ---------- */
		$( '#pnmf-log-list' ).addEventListener( 'click', ( e ) => {
			const btn = e.target.closest( '[data-undo]' );
			if ( btn ) {
				undoLog( parseInt( btn.dataset.undo, 10 ) );
			}
		} );

		/* ---------- 對話框關閉 ---------- */
		document.querySelectorAll( '.pnmf-modal' ).forEach( ( modal ) => {
			modal.addEventListener( 'click', ( e ) => {
				if ( e.target === modal || e.target.closest( '[data-close]' ) ) {
					modal.hidden = true;
				}
			} );
		} );

		document.addEventListener( 'keydown', ( e ) => {
			if ( e.key !== 'Escape' ) {
				return;
			}

			/* 框選進行中 → 先取消框選 */
			if ( marquee ) {
				marqueeCancel();
				return;
			}

			document.querySelectorAll( '.pnmf-modal' ).forEach( ( m ) => {
				m.hidden = true;
			} );
		} );

		$( '#pnmf-progress-cancel' ).addEventListener( 'click', async () => {
			autoCancelled = true;
			try {
				const data = await api( 'auto_cancel', {} );
				progress( false );
				toast( data.message, 'ok' );
				await refresh( true );
			} catch ( e ) {
				toast( e.message, 'error' );
			}
		} );
	}

	
	/* Pro 等附加外掛的擴展點（wp.org 規範：Pro 代碼在 Pro 外掛內，
	 * 透過此 API 與免費版協作）。 */
	window.PNMF_UI = { state, $, esc, __, sprintf, toast, api, refresh, loadTree, renderTree, renderFoldersBar, currentScope, selectedIds, openModal, closeModal, progress, loadMedia, dupeDeleteIds: () => Array.from( document.querySelectorAll( '.pnmf-dupe-del:checked' ) ).map( ( c ) => parseInt( c.value, 10 ) ).filter( Boolean ), dupeRerun: () => runDupeScan( false ) };

/* =========================================================
	 *  啟動
	 * ========================================================= */

	document.addEventListener( 'DOMContentLoaded', () => {
		renderStats( state.stats );
		renderTree();
		renderTags();
		bindEvents();
		loadMedia();

		/* 一進頁面就顯示「新增功能在哪裡」導覽（可關掉，之後用工具列按鈕再看）。 */
		if ( CFG.guide ) {
			setTimeout( () => openModal( '#pnmf-modal-guide' ), 350 );
		}

		const guideBtn = document.getElementById( 'pnmf-btn-guide' );
		if ( guideBtn ) {
			guideBtn.addEventListener( 'click', () => openModal( '#pnmf-modal-guide' ) );
		}

		const guideClose = document.getElementById( 'pnmf-guide-close' );
		if ( guideClose ) {
			guideClose.addEventListener( 'click', async () => {
				const mute = document.getElementById( 'pnmf-guide-mute' );
				if ( mute && mute.checked ) {
					try {
						await api( 'guide_mute', {} );
						CFG.guide = 0;
					} catch ( e ) { /* 記不住就算了，下次再說 */ }
				}
				closeModal( '#pnmf-modal-guide' );
			} );
		}
	} );
} )();
