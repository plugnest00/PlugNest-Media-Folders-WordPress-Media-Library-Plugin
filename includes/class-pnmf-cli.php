<?php
/**
 * PlugNest Media Folders — WP-CLI 命令。
 *
 *   wp pnmf stats                     媒體庫統計摘要
 *   wp pnmf hash-build [--limit=N]    分批為缺雜湊的檔案建索引（重複檔偵測前置）
 *   wp pnmf dupe-scan [--groups=N]    建完索引後列出重複群組摘要
 *   wp pnmf usage-scan [--limit=N]    分批掃描使用狀態
 *
 * 只在 WP-CLI 環境註冊（defined('WP_CLI')），一般請求零成本。
 * CLI 輸出不走 gettext（維運腳本慣例，輸出保持英文）。
 *
 * @package PlugNest Media Folders
 */

defined( 'ABSPATH' ) || exit;

if ( ! defined( 'WP_CLI' ) || ! WP_CLI || ! class_exists( 'WP_CLI_Command' ) ) {
	return;
}

/**
 * PlugNest Media Folders CLI commands.
 */
class PNMF_CLI_Commands extends WP_CLI_Command {

	/**
	 * Media library stats summary.
	 *
	 * ## EXAMPLES
	 *
	 *     wp pnmf stats
	 */
	public function stats( $args, $assoc_args ) {
		$s = PNMF_Query::stats();
		WP_CLI::line( 'total=' . ( isset( $s['total'] ) ? (int) $s['total'] : 0 ) );
		WP_CLI::line( 'folders=' . ( isset( $s['folders'] ) ? (int) $s['folders'] : 0 ) );
		WP_CLI::line( 'unassigned=' . ( isset( $s['unassigned'] ) ? (int) $s['unassigned'] : 0 ) );
		WP_CLI::line( 'used=' . ( isset( $s['used'] ) ? (int) $s['used'] : 0 ) );
		WP_CLI::line( 'unused=' . ( isset( $s['unused'] ) ? (int) $s['unused'] : 0 ) );
		WP_CLI::success( 'stats done' );
	}

	/**
	 * Build the duplicate-detection hash index in batches.
	 *
	 * [--limit=<n>]
	 * : Files per batch (default 300, max 500).
	 *
	 * [--force]
	 * : Clear all existing hashes first (full re-hash).
	 *
	 * ## EXAMPLES
	 *
	 *     wp pnmf hash-build
	 *     wp pnmf hash-build --force
	 *
	 * @subcommand hash-build
	 */
	public function hash_build( $args, $assoc_args ) {
		$limit = isset( $assoc_args['limit'] ) ? max( 1, min( 500, (int) $assoc_args['limit'] ) ) : 300;

		if ( ! empty( $assoc_args['force'] ) ) {
			PNMF_Dupe::flush();
			WP_CLI::log( 'existing hashes cleared' );
		}

		$start    = microtime( true );
		$hashed   = 0;
		$guard    = 0;

		while ( $guard++ < 5000 ) {
			$b = PNMF_Dupe::build_batch( $limit );
			if ( 0 === $b['processed'] ) {
				break;
			}
			$hashed += (int) $b['hashed'];
			if ( $b['done'] ) {
				break;
			}
		}

		$elapsed = round( microtime( true ) - $start, 1 );
		WP_CLI::success( "hash build done: hashed={$hashed} missing=" . PNMF_Dupe::missing_count() . " in {$elapsed}s" );
	}

	/**
	 * List duplicate file groups (builds missing hashes first).
	 *
	 * [--groups=<n>]
	 * : Max groups to display (default 20).
	 *
	 * ## EXAMPLES
	 *
	 *     wp pnmf dupe-scan
	 *     wp pnmf dupe-scan --groups=50
	 *
	 * @subcommand dupe-scan
	 */
	public function dupe_scan( $args, $assoc_args ) {
		/* 先把缺的雜湊補完（冪等，已建好時瞬間完成）。 */
		$guard = 0;
		while ( $guard++ < 5000 ) {
			$b = PNMF_Dupe::build_batch( 300 );
			if ( $b['done'] || 0 === $b['processed'] ) {
				break;
			}
		}

		$max   = isset( $assoc_args['groups'] ) ? max( 1, min( 500, (int) $assoc_args['groups'] ) ) : 20;
		$data  = PNMF_Dupe::groups( 500 );

		WP_CLI::line( 'groups=' . (int) $data['group_count'] . ' redundant_copies=' . (int) $data['dupe_count'] . ( ! empty( $data['truncated'] ) ? ' (more beyond 500)' : '' ) );

		$shown = 0;
		foreach ( $data['groups'] as $g ) {
			if ( $shown >= $max ) {
				break;
			}
			$shown++;
			$names = array();
			foreach ( $g['items'] as $it ) {
				$names[] = '[' . $it['id'] . '] ' . $it['filename'];
			}
			WP_CLI::line( 'G' . $shown . ' (' . $g['count'] . ' copies): ' . implode( ' | ', $names ) );
		}

		WP_CLI::success( 'dupe scan done' );
	}

	/**
	 * Scan media usage status in batches.
	 *
	 * [--limit=<n>]
	 * : Media per batch (default 200).
	 *
	 * ## EXAMPLES
	 *
	 *     wp pnmf usage-scan
	 *
	 * @subcommand usage-scan
	 */
	public function usage_scan( $args, $assoc_args ) {
		$limit = isset( $assoc_args['limit'] ) ? max( 1, min( 500, (int) $assoc_args['limit'] ) ) : 200;

		$offset = 0;
		$guard  = 0;
		$unused = 0;

		while ( $guard++ < 5000 ) {
			$b = PNMF_Usage::scan_batch( $offset, $limit, 1 === $guard );
			$unused += (int) $b['unused'];
			$offset  = (int) $b['processed'];
			if ( $b['done'] || 0 === $b['batch'] ) {
				break;
			}
		}

		WP_CLI::success( "usage scan done: processed={$offset} unused={$unused}" );
	}
}

WP_CLI::add_command( 'pnmf', 'PNMF_CLI_Commands' );
