<?php
/**
 * PlugNest Media Folders — 媒體框（wp.media）整合。
 *
 * Elementor、古騰堡等「插入媒體」用的都是核心媒體框（wp.media）。
 * 在不改寫框本體的前提下，用 Backbone 擴充加上兩個功能：
 *   1. 「上傳檔案」頁籤：上傳到資料夾 下拉 —— 上傳前就指定資料夾，
 *      與「媒體 → 新增媒體」頁的上傳下拉同一套後端邏輯。
 *   2. 「插入媒體」瀏覽頁籤：資料夾篩選下拉 —— 只看某個資料夾（含子資料夾）的媒體。
 *
 * 後端只有兩件事：
 *   - ajax_query_attachments_args：讓 query-attachments 認得 pnmf_folder 參數
 *   - 上傳歸類沿用 PNMF_Upload::assign_folder()（multipart 帶 pnmf_folder + nonce）
 *
 * 與外掛其他部分一致：只動分類關係，完全不碰檔案與網址。
 *
 * @package PlugNest Media Folders
 */

defined( 'ABSPATH' ) || exit;

class PNMF_Modal {

	/** @var PNMF_Modal|null */
	private static $instance = null;

	/** @return PNMF_Modal */
	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function __construct() {
		add_action( 'admin_enqueue_scripts', array( $this, 'assets' ) );
		/*
		 * Elementor 編輯器頁（post.php?action=elementor）會 remove_all_actions()
		 * 重設腳本印出管線、走自己的印出流程，admin_enqueue_scripts 的入隊
		 * 不會被印出 —— 必須改掛 Elementor 官方的編輯器入隊鉤子才會載入。
		 */
		add_action( 'elementor/editor/before_enqueue_scripts', array( $this, 'assets' ) );
		add_filter( 'ajax_query_attachments_args', array( $this, 'filter_query' ) );
	}

	/**
	 * 載入資源。
	 *
	 * 媒體框可能出現在任何後台頁面（文章編輯、Elementor、小工具、自訂器、
	 * upload.php 網格模式……），所以這裡不加頁面判斷，全部後台頁都帶上；
	 * JS 本身會在沒有 wp.media 的環境自動閉嘴，CSS 只有幾行。
	 */
	public function assets() {
		if ( ! current_user_can( 'upload_files' ) ) {
			return;
		}

		wp_enqueue_style(
			'pnmf-modal',
			PNMF_URL . 'assets/css/modal.css',
			array(),
			PNMF_Plugin::asset_ver( 'assets/css/modal.css' )
		);

		wp_enqueue_script(
			'pnmf-modal',
			PNMF_URL . 'assets/js/modal.js',
			array( 'media-editor' ),
			PNMF_Plugin::asset_ver( 'assets/js/modal.js' ),
			true
		);

		wp_localize_script(
			'pnmf-modal',
			'PNMF_MODAL',
			array(
				/* 角色限制：媒體框的下拉只列出使用者看得到的資料夾。 */
				'folders' => PNMF_Taxonomy::visible_folder_tree( true ),
				'field'   => PNMF_Upload::FIELD,
				'nonce'   => wp_create_nonce( PNMF_Upload::NONCE_ACTION ),
				'strings' => array(
					'uploadTo'    => __( 'Upload to folder:', 'plugnest-media-folders' ),
					'unspecified' => __( '(none — classify later)', 'plugnest-media-folders' ),
					'filterBy'    => __( 'Folder:', 'plugnest-media-folders' ),
					'all'         => __( 'All folders', 'plugnest-media-folders' ),
					'unassigned'  => __( 'Unassigned', 'plugnest-media-folders' ),
				),
			)
		);
	}

	/**
	 * 讓 query-attachments（媒體框的瀏覽查詢）支援資料夾篩選。
	 *
	 * 資料夾參數由前端 ajaxPrefilter 掛在請求「頂層」（pnmf_folder），
	 * 因為核心 wp_ajax_query_attachments 會用白名單（array_intersect_key）
	 * 把 query 物件裡的自訂鍵在過濾器執行前就剝掉。
	 *
	 * 兼容另一種傳法：參數放在 query 物件內（$args['pnmf_folder']）。
	 *
	 * @param array $args query-attachments 的查詢參數。
	 * @return array
	 */
	public function filter_query( $args ) {
		$folder = '';
		// phpcs:disable WordPress.Security.NonceVerification.Recommended -- 唯讀篩選參數，核心本端點亦無 nonce。
		if ( isset( $_REQUEST['pnmf_folder'] ) ) {
			$folder = sanitize_text_field( wp_unslash( $_REQUEST['pnmf_folder'] ) );
		} elseif ( isset( $args['pnmf_folder'] ) ) {
			$folder = sanitize_text_field( (string) $args['pnmf_folder'] );
			unset( $args['pnmf_folder'] );
		}
		// phpcs:enable

		if ( ! isset( $args['tax_query'] ) || ! is_array( $args['tax_query'] ) ) {
			$args['tax_query'] = array();
		}

		/*
		 * 角色限制：看不到的資料夾（含子孫）一律排除。
		 *
		 * 這一段必須放在「任何 early return 之前」——否則不指定資料夾時
		 * （$folder === ''）會提早 return，媒體框就把受限媒體全部列出來了。
		 */
		$restricted = PNMF_Taxonomy::restricted_folder_ids_for_user();
		if ( ! empty( $restricted ) ) {
			$args['tax_query'][] = array(
				'taxonomy'         => PNMF_TAX_FOLDER,
				'field'            => 'term_id',
				'terms'            => $restricted,
				'operator'         => 'NOT IN',
				'include_children' => false,
			);
		}

		if ( '' === $folder ) {
			return $args;
		}

		if ( 'none' === $folder ) {
			$args['tax_query'][] = array(
				'taxonomy' => PNMF_TAX_FOLDER,
				'operator' => 'NOT EXISTS',
			);
			return $args;
		}

		$folder_id = (int) $folder;
		if ( $folder_id <= 0 ) {
			return $args;
		}

		$ids = PNMF_Taxonomy::get_descendant_ids( $folder_id );
		if ( empty( $ids ) ) {
			$ids = array( $folder_id );
		}

		$args['tax_query'][] = array(
			'taxonomy' => PNMF_TAX_FOLDER,
			'field'    => 'term_id',
			'terms'    => $ids,
			'operator' => 'IN',
		);

		return $args;
	}
}
